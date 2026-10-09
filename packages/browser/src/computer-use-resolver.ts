import { Page, ElementHandle } from 'playwright';
import {
  SemanticTargetType,
  ResolvedTarget,
  PageObservation,
  PageObservationProduct,
  ShoppingProduct,
} from '@nexa/shared';

export interface ObservationOptions {
  includeScreenshot?: boolean;
  maxTextLength?: number;
}

export class ComputerUseResolver {
  /**
   * Observes the current page state, extracting search inputs, action buttons,
   * product listings, and accessible text without requiring hard-coded selectors.
   */
  public async observePage(page: Page, options?: ObservationOptions): Promise<PageObservation> {
    const start = Date.now();
    const url = page.url();
    const title = await page.title().catch(() => '');

    let observationData: {
      textSummary: string;
      searchInputs: Array<{
        selector: string;
        placeholder?: string;
        name?: string;
        id?: string;
        ariaLabel?: string;
        confidence: number;
      }>;
      actionButtons: Array<{
        selector: string;
        text: string;
        targetType: SemanticTargetType;
        confidence: number;
        role?: string;
      }>;
      products: PageObservationProduct[];
      cartSummary?: { itemCount: number; totalText?: string };
      isProductDetailPage?: boolean;
      currentAsin?: string;
    } = {
      textSummary: '',
      searchInputs: [],
      actionButtons: [],
      products: [],
    };

    if (!page.isClosed()) {
      try {
        observationData = await page.evaluate(() => {
          const isVisible = (el: Element): boolean => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          // 1. Text Summary
          const bodyText = (document.body.innerText || '').slice(0, 3000).trim();

          // 2. Discover Search Inputs
          const searchInputs: Array<{
            selector: string;
            placeholder?: string;
            name?: string;
            id?: string;
            ariaLabel?: string;
            confidence: number;
          }> = [];

          const allInputs = Array.from(
            document.querySelectorAll('input, textarea, [role="searchbox"], [role="search"] input, [role="search"] textarea, [role="combobox"]')
          );
          for (let i = 0; i < allInputs.length; i++) {
            const input = allInputs[i] as HTMLElement;
            if (!isVisible(input)) continue;

            const tag = input.tagName.toLowerCase();
            const type = (input.getAttribute('type') || (tag === 'textarea' ? 'text' : 'text')).toLowerCase();
            if (['hidden', 'password', 'submit', 'button', 'checkbox', 'radio'].includes(type)) continue;

            const placeholder = input.getAttribute('placeholder') || '';
            const ariaLabel = input.getAttribute('aria-label') || '';
            const name = input.getAttribute('name') || '';
            const id = input.getAttribute('id') || '';
            const testId = input.getAttribute('data-testid') || input.getAttribute('data-test-id') || '';

            let confidence = 0.5;
            const searchTerms = ['search', 'find', 'query', 'look for', 'item', 'grocery', 'product'];
            const combined = `${placeholder} ${ariaLabel} ${name} ${id} ${testId} ${type}`.toLowerCase();

            if (type === 'search' || input.getAttribute('role') === 'searchbox') {
              confidence = 0.95;
            } else if (name === 'q' || ariaLabel.toLowerCase() === 'search') {
              confidence = 0.95;
            } else if (tag === 'textarea' && (name === 'q' || ariaLabel.toLowerCase().includes('search'))) {
              confidence = 0.95;
            } else if (searchTerms.some((t) => combined.includes(t))) {
              confidence = 0.9;
            } else if (i === 0) {
              confidence = 0.6;
            }

            // Derive stable selector
            let selector = '';
            if (id) {
              selector = `#${CSS.escape(id)}`;
            } else if (name) {
              selector = `${tag}[name="${CSS.escape(name)}"]`;
            } else if (testId) {
              selector = `[data-testid="${CSS.escape(testId)}"]`;
            } else if (ariaLabel) {
              selector = `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
            } else if (placeholder) {
              selector = `${tag}[placeholder="${CSS.escape(placeholder)}"]`;
            } else {
              selector = `${tag}:nth-of-type(${i + 1})`;
            }

            searchInputs.push({
              selector,
              placeholder,
              name,
              id,
              ariaLabel,
              confidence,
            });
          }

          // Sort search inputs by confidence descending
          searchInputs.sort((a, b) => b.confidence - a.confidence);

          // 3. Discover Action Buttons (Add to Cart, Checkout, Address)
          const actionButtons: Array<{
            selector: string;
            text: string;
            targetType: SemanticTargetType;
            confidence: number;
            role?: string;
          }> = [];

          const clickables = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
          for (let i = 0; i < clickables.length; i++) {
            const el = clickables[i] as HTMLElement;
            if (!isVisible(el)) continue;

            const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim();
            if (!text && !el.getAttribute('data-testid')) continue;

            const cleanText = text.toLowerCase();
            const id = el.getAttribute('id') || '';
            const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '';
            const className = (el.getAttribute('class') || '').toLowerCase();

            let targetType: SemanticTargetType | null = null;
            let confidence = 0.7;

            // Classify button semantics
            if (/\b(add to cart|add to basket|add\b|\+ add|buy now)\b/i.test(cleanText) || testId.includes('add') || className.includes('add-to-cart')) {
              targetType = 'add_to_cart';
              confidence = /\b(add to cart|add)\b/i.test(cleanText) ? 0.95 : 0.85;
            } else if (/\b(checkout|proceed to pay|place order|proceed to checkout|view cart|pay now)\b/i.test(cleanText) || testId.includes('checkout')) {
              targetType = 'checkout';
              confidence = 0.95;
            } else if (/\b(deliver to|delivery address|select address|change address|location)\b/i.test(cleanText) || testId.includes('address')) {
              targetType = 'address';
              confidence = 0.9;
            } else if (/\b(cart|basket)\b/i.test(cleanText) || testId.includes('cart')) {
              targetType = 'cart_icon';
              confidence = 0.8;
            }

            if (targetType) {
              let selector = '';
              if (id) {
                selector = `#${CSS.escape(id)}`;
              } else if (testId) {
                selector = `[data-testid="${CSS.escape(testId)}"]`;
              } else if (el.tagName.toLowerCase() === 'button') {
                selector = `button:has-text("${text.slice(0, 30)}")`;
              } else {
                selector = `${el.tagName.toLowerCase()}:has-text("${text.slice(0, 30)}")`;
              }

              actionButtons.push({
                selector,
                text,
                targetType,
                confidence,
                role: el.getAttribute('role') || el.tagName.toLowerCase(),
              });
            }
          }

          // 4. Discover Products on Page
          const products: PageObservationProduct[] = [];

          // First check: Are we on a product detail page?
          const productTitleEl = document.querySelector('#productTitle, h1.product-title, [data-testid="product-title"]');
          const asinMatch = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
          const currentAsin = asinMatch ? asinMatch[1] : (document.querySelector('input[name="ASIN"], input#ASIN') as HTMLInputElement)?.value || undefined;
          const isDetailPage = Boolean(
            (productTitleEl && isVisible(productTitleEl)) ||
            currentAsin ||
            location.pathname.includes('/dp/') ||
            location.pathname.includes('/gp/product/')
          );

          if (isDetailPage && productTitleEl) {
            const titleText = (productTitleEl as HTMLElement).innerText.trim();
            const priceEl = document.querySelector(
              '.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #corePrice_feature_div .a-price-whole, .a-price-whole, [data-testid="price"]'
            );
            const priceText = priceEl ? (priceEl as HTMLElement).innerText.trim() : '';
            const priceMatch = (priceText || bodyText).match(/(?:₹|rs\.?|\$)\s*([\d,]+(?:\.\d{2})?)/i);
            const numericPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : undefined;
            const packMatch =
              titleText.match(/(\d+)\s*(?:[- ]?pack|pcs|piece|pieces|units?|count|set)\b/i) ||
              titleText.match(/\b(?:pack of|set of)\s*(\d+)/i);
            const packSize = packMatch ? parseInt(packMatch[1], 10) : 1;

            products.push({
              title: titleText,
              price: priceMatch ? priceMatch[0] : (priceText || undefined),
              rawPrice: numericPrice,
              selector: '#add-to-cart-button',
              url: location.href,
              href: location.href,
              asin: currentAsin,
              packSize,
            });
          }

          // Search result cards / product listings
          const candidateCards = Array.from(
            document.querySelectorAll(
              '[data-component-type="s-search-result"], [data-asin]:not([data-asin=""]), [data-testid*="product"], [class*="product"], [class*="item"], div.s-result-item'
            )
          );

          for (const card of candidateCards) {
            if (!isVisible(card)) continue;
            const text = (card as HTMLElement).innerText || '';
            const priceMatch = text.match(/(?:₹|rs\.?|\$)\s*([\d,]+(?:\.\d{2})?)/i);
            if (priceMatch) {
              const cardAsin = card.getAttribute('data-asin') || card.closest('[data-asin]')?.getAttribute('data-asin') || undefined;
              const headingEl = card.querySelector('h2 a, a.a-link-normal[href*="/dp/"], h2, h3, [class*="title"], [class*="name"]');
              const linkEl =
                (headingEl && headingEl.tagName.toLowerCase() === 'a' ? headingEl : null) ||
                card.querySelector('a.a-link-normal[href*="/dp/"], h2 a, a[href*="/dp/"], a[href*="product"]') ||
                headingEl?.closest('a') ||
                card.querySelector('a');

              let rawHref = linkEl?.getAttribute('href') || '';
              let productUrl = '';
              if (rawHref) {
                try {
                  productUrl = new URL(rawHref, document.baseURI).href;
                } catch {
                  productUrl = rawHref;
                }
              } else if (cardAsin) {
                productUrl = `https://www.amazon.in/dp/${cardAsin}`;
              }

              const titleText = headingEl ? (headingEl as HTMLElement).innerText.trim() : (linkEl ? (linkEl as HTMLElement).innerText.trim() : '');
              if (titleText && titleText.length > 3 && titleText.length < 250) {
                const numericPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
                if (!products.some((p) => p.title === titleText || (cardAsin && p.asin === cardAsin))) {
                  const packMatch =
                    titleText.match(/(\d+)\s*(?:[- ]?pack|pcs|piece|pieces|units?|count|set)\b/i) ||
                    titleText.match(/\b(?:pack of|set of)\s*(\d+)/i) ||
                    text.match(/(\d+)\s*(?:[- ]?pack|pcs|piece|pieces|units?|count|set)\b/i);
                  const packSize = packMatch ? parseInt(packMatch[1], 10) : undefined;

                  let selector = '';
                  if (cardAsin) {
                    selector = `[data-asin="${cardAsin}"] h2 a, [data-asin="${cardAsin}"] a.a-link-normal`;
                  } else if (card.id) {
                    selector = `#${card.id} a`;
                  } else if (linkEl && linkEl.getAttribute('href')) {
                    selector = `a[href*="${linkEl.getAttribute('href')!.slice(0, 30)}"]`;
                  }

                  products.push({
                    title: titleText,
                    price: priceMatch[0],
                    rawPrice: isNaN(numericPrice) ? undefined : numericPrice,
                    selector: selector || undefined,
                    url: productUrl || undefined,
                    href: productUrl || undefined,
                    asin: cardAsin,
                    packSize,
                  });
                }
              }
            }
            if (products.length >= 10) break;
          }

          // 5. Cart Summary
          let cartSummary: { itemCount: number; totalText?: string } | undefined;
          const cartTextMatch = bodyText.match(/(?:(\d+)\s*items?|cart\s*\((\d+)\))/i);
          const totalMatch = bodyText.match(/(?:total|subtotal|grand total)[:\s]*([₹$€]\s*[\d,]+(?:\.\d{2})?)/i);
          if (cartTextMatch || totalMatch) {
            cartSummary = {
              itemCount: cartTextMatch ? parseInt(cartTextMatch[1] || cartTextMatch[2] || '0', 10) : 0,
              totalText: totalMatch ? totalMatch[1] : undefined,
            };
          }

          return {
            textSummary: bodyText,
            searchInputs,
            actionButtons,
            products,
            cartSummary,
            isProductDetailPage: isDetailPage,
            currentAsin,
          };
        });
      } catch (err: any) {
        // Fallback for mocked page or evaluate failure
        observationData.textSummary = (await page.content().catch(() => '')).slice(0, 1000);
      }
    }

    const searchResolved: ResolvedTarget[] = observationData.searchInputs.map((s) => ({
      selector: s.selector,
      confidence: s.confidence,
      targetType: 'search_box',
      description: s.placeholder || s.ariaLabel || s.name || 'Search input',
      role: 'searchbox',
      name: s.name,
      matchedBy: s.id ? 'id' : s.placeholder ? 'placeholder' : s.ariaLabel ? 'aria' : 'css',
    }));

    const actionsResolved: ResolvedTarget[] = observationData.actionButtons.map((b) => ({
      selector: b.selector,
      confidence: b.confidence,
      targetType: b.targetType,
      description: b.text,
      role: b.role,
      matchedBy: 'text',
    }));

    const latency = Date.now() - start;
    console.log(
      `[ComputerUse] page_observed url="${url}" inputs_count=${searchResolved.length} buttons_count=${actionsResolved.length} products_count=${observationData.products.length} latency_ms=${latency}`
    );

    return {
      url,
      title,
      textSummary: observationData.textSummary,
      searchInputs: searchResolved,
      actionButtons: actionsResolved,
      products: observationData.products,
      cartSummary: observationData.cartSummary,
      isProductDetailPage: observationData.isProductDetailPage,
      currentAsin: observationData.currentAsin,
    };
  }

  /**
   * Resolves an interactive target dynamically using accessible roles, text,
   * placeholder, heuristics, or coordinates instead of brittle hardcoded selectors.
   */
  public async resolveTarget(
    page: Page,
    target: string,
    targetType?: SemanticTargetType
  ): Promise<ResolvedTarget | null> {
    const start = Date.now();
    const cleanTarget = target.trim();

    // Tag-agnostic [name="..."] attribute lookup (e.g. input[name="q"] -> [name="q"] matching <textarea name="q">)
    const nameMatch = cleanTarget.match(/^(?:input|textarea)?\[name=["']?([^"'\]]+)["']?\]$/i);
    if (nameMatch && nameMatch[1]) {
      const nameAttr = nameMatch[1];
      const agnosticSelector = `[name="${nameAttr}"]`;
      try {
        const handle = await page.$(agnosticSelector);
        if (handle) {
          const latency = Date.now() - start;
          console.log(
            `[ComputerUse] target_resolved action=resolve target_type=${targetType || 'search_box'} matched_by=name latency_ms=${latency} selector="${agnosticSelector}"`
          );
          return {
            selector: agnosticSelector,
            confidence: 0.95,
            targetType: targetType || (nameAttr === 'q' ? 'search_box' : 'custom'),
            description: `Element with name="${nameAttr}"`,
            name: nameAttr,
            matchedBy: 'name',
          };
        }
      } catch {}
    }

    // 1. If targetType is 'search_box' or target expresses a search intent
    const isSearchTarget =
      targetType === 'search_box' ||
      /(search|find|query|\[name=["']?q["']?\]|name=['"]?q['"]?)/i.test(cleanTarget);

    if (isSearchTarget) {
      let observation = await this.observePage(page);
      if (observation.searchInputs.length === 0) {
        await new Promise((r) => setTimeout(r, 350));
        observation = await this.observePage(page);
      }
      if (observation.searchInputs.length > 0) {
        const best = observation.searchInputs[0];
        const latency = Date.now() - start;
        console.log(
          `[ComputerUse] target_resolved action=resolve target_type=search_box matched_by=${best.matchedBy} latency_ms=${latency} selector="${best.selector}"`
        );
        return best;
      }
    }

    // 2. If targetType is 'add_to_cart' or target expresses add to cart
    if (targetType === 'add_to_cart' || /\b(add to cart|add|buy now)\b/i.test(cleanTarget)) {
      const observation = await this.observePage(page);
      const addBtn = observation.actionButtons.find((b) => b.targetType === 'add_to_cart');
      if (addBtn) {
        const latency = Date.now() - start;
        console.log(
          `[ComputerUse] target_resolved action=resolve target_type=add_to_cart matched_by=text latency_ms=${latency} selector="${addBtn.selector}"`
        );
        return addBtn;
      }
    }

    // 3. If targetType is 'checkout' or target expresses checkout
    if (targetType === 'checkout' || /\b(checkout|place order|proceed to pay|pay now)\b/i.test(cleanTarget)) {
      const observation = await this.observePage(page);
      const checkoutBtn = observation.actionButtons.find((b) => b.targetType === 'checkout');
      if (checkoutBtn) {
        const latency = Date.now() - start;
        console.log(
          `[ComputerUse] target_resolved action=resolve target_type=checkout matched_by=text latency_ms=${latency} selector="${checkoutBtn.selector}"`
        );
        return checkoutBtn;
      }
    }

    // 4. Try direct valid CSS selector
    try {
      const handle = await page.$(cleanTarget);
      if (handle) {
        const latency = Date.now() - start;
        console.log(
          `[ComputerUse] target_resolved action=resolve target_type=${targetType || 'custom'} matched_by=css latency_ms=${latency} selector="${cleanTarget}"`
        );
        return {
          selector: cleanTarget,
          confidence: 1.0,
          targetType: targetType || 'custom',
          description: cleanTarget,
          matchedBy: 'css',
        };
      }
    } catch {
      // Not a valid CSS selector; continue to semantic/text resolution
    }

    // 5. Try Playwright Accessible Locators (Role + Name, Text, Placeholder)
    try {
      // By Role 'button'
      const roleBtn = page.getByRole('button', { name: cleanTarget });
      if ((await roleBtn.count().catch(() => 0)) > 0) {
        const latency = Date.now() - start;
        console.log(
          `[ComputerUse] target_resolved action=resolve target_type=${targetType || 'custom'} matched_by=role latency_ms=${latency} selector="role=button[name='${cleanTarget}']"`
        );
        return {
          selector: `button:has-text("${cleanTarget}")`,
          confidence: 0.95,
          targetType: targetType || 'custom',
          description: cleanTarget,
          role: 'button',
          matchedBy: 'role',
        };
      }

      // By Placeholder
      const placeholderEl = page.getByPlaceholder(cleanTarget);
      if ((await placeholderEl.count().catch(() => 0)) > 0) {
        const latency = Date.now() - start;
        console.log(
          `[ComputerUse] target_resolved action=resolve target_type=${targetType || 'search_box'} matched_by=placeholder latency_ms=${latency}`
        );
        return {
          selector: `input[placeholder*="${cleanTarget}"]`,
          confidence: 0.9,
          targetType: targetType || 'search_box',
          description: cleanTarget,
          matchedBy: 'placeholder',
        };
      }

      // By Visible Text
      const textEl = page.getByText(cleanTarget);
      if ((await textEl.count().catch(() => 0)) > 0) {
        const latency = Date.now() - start;
        console.log(
          `[ComputerUse] target_resolved action=resolve target_type=${targetType || 'custom'} matched_by=text latency_ms=${latency}`
        );
        return {
          selector: `:has-text("${cleanTarget}")`,
          confidence: 0.85,
          targetType: targetType || 'custom',
          description: cleanTarget,
          matchedBy: 'text',
        };
      }
    } catch {
      // Fall through to observation heuristics
    }

    // 6. Dynamic DOM Observation matching
    const observation = await this.observePage(page);

    // Check action buttons containing text
    const matchedBtn = observation.actionButtons.find((b) =>
      (b.text || b.description || '').toLowerCase().includes(cleanTarget.toLowerCase())
    );
    if (matchedBtn) {
      const latency = Date.now() - start;
      console.log(
        `[ComputerUse] target_resolved action=resolve target_type=${matchedBtn.targetType} matched_by=heuristics latency_ms=${latency} selector="${matchedBtn.selector}"`
      );
      return matchedBtn;
    }

    // Check search inputs
    if (observation.searchInputs.length > 0 && targetType === 'search_box') {
      return observation.searchInputs[0];
    }

    return null;
  }
}

export const computerUseResolver = new ComputerUseResolver();
