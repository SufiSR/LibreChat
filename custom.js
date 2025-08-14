(function () {
  'use strict';

  // Prevent double-initialization if this file is loaded twice.
  if (window.__ModelInfoPanelLoaded) return;
  window.__ModelInfoPanelLoaded = true;

  /* ============================== Defaults ============================== */
  const DEFAULT_CFG = {
    NAV_SELECTOR: 'nav#controls-nav',
    SOURCE_SELECTOR: 'span.flex-grow.truncate.text-left', // unique on the page (exclude our injection)
    INJECTION_ATTR: 'data-modelinfo-injection',
    CONTENT_CLASS: 'modelinfo-content',
    POLL_MS: 500, // gentle, low-overhead
    BUTTON_LABEL: 'Model Information',
    OPENROUTER_MODELS_URL: 'https://openrouter.ai/api/v1/models',
    AUTO_START: true, // set false if you want to call start() yourself

    // Agents menu placement
    AGENTS_MENU_ID: 'endpoint-agents-menu',
    AGENTS_REORDER_MIN_MS: 1500, // throttle subsequent reorders after initial placement

    // GPT plugins menu hide
    PLUGINS_MENU_ID: 'endpoint-gptPlugins-menu',
    PLUGINS_HIDE_MIN_MS: 1500, // throttle subsequent visibility checks after initial hide
  };

  /* ============================== Internal State ============================== */
  const state = {
    cfg: { ...DEFAULT_CFG },
    intervalId: null,
    lastModelName: null,
    lastHTML: null,
    remote: null,          // OpenRouter API result
    remoteLoading: false,
    remoteError: null,

    // re-tick / transition awareness
    wasOpen: false,
    lastAgentsReorderAt: 0,
    lastPluginsHideAt: 0,
  };

  /* ============================== Query Helpers ============================== */
  const qNav = () => document.querySelector(state.cfg.NAV_SELECTOR);
  const isNavOpen = (nav) => {
    const firstChild = nav && nav.querySelector(':scope > div');
    return !!firstChild && firstChild.getAttribute('data-collapsed') === 'false';
  };
  const qInjection = () => document.querySelector(`[${state.cfg.INJECTION_ATTR}]`);
  const qInjectedPanel = (wrap) => wrap?.querySelector('[role="region"]') || null;
  const qInjectedButton = (wrap) => wrap?.querySelector('button') || null;
  const qInjectedContent = (wrap) => wrap?.querySelector(`.${state.cfg.CONTENT_CLASS}`) || null;

  // Find the unique source span; exclude anything inside our own injection to avoid feedback loops
  const qSourceSpan = () => {
    const nodes = document.querySelectorAll(state.cfg.SOURCE_SELECTOR);
    for (const el of nodes) if (!el.closest(`[${state.cfg.INJECTION_ATTR}]`)) return el;
    return null;
  };

  /* ============================== UI Helpers ============================== */
  function setPanelHeightVar(panelEl) {
    if (!panelEl) return;
    const inner = panelEl.querySelector(':scope > .pb-4, :scope > div');
    const h = (inner || panelEl).scrollHeight;
    panelEl.style.setProperty('--radix-collapsible-content-height', `${h}px`);
  }

  function setOpen(btn, panel, open) {
    if (!btn || !panel) return;
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('data-state', open ? 'open' : 'closed');
    panel.setAttribute('data-state', open ? 'open' : 'closed');
    panel.hidden = !open;
    if (open) setPanelHeightVar(panel);
  }

  function buildInjection() {
    const wrapper = document.createElement('div');
    wrapper.setAttribute(state.cfg.INJECTION_ATTR, 'true');
    wrapper.setAttribute('data-orientation', 'vertical');
    wrapper.innerHTML = `
      <div data-state="closed" data-orientation="vertical" class="border-b w-full border-none">
        <button
          class="inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-border-light hover:bg-accent hover:text-accent-foreground h-9 rounded-lg px-3 w-full justify-start bg-transparent text-text-secondary data-[state=open]:bg-surface-secondary data-[state=open]:text-text-primary"
          type="button"
          aria-expanded="true"
          data-state="open"
          data-orientation="vertical"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb">
            <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"></path>
            <path d="M9 18h6"></path>
            <path d="M10 22h4"></path>
          </svg>
          ${state.cfg.BUTTON_LABEL}
        </button>

        <div
          role="region"
          data-state="open"
          data-orientation="vertical"
          class="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
          style="--radix-accordion-content-height: var(--radix-collapsible-content-height); --radix-accordion-content-width: var(--radix-collapsible-content-width);"
        >
          <div class="pb-4 pt-0 w-full text-text-primary">
            <div class="h-auto max-w-full overflow-x-hidden p-3">
              <div class="pb-4 pt-0 w-full text-text-primary ${state.cfg.CONTENT_CLASS}">Loading…</div>
            </div>
          </div>
        </div>
      </div>
    `;
    return wrapper;
  }

  function bindToggle(wrapper) {
    const btn = qInjectedButton(wrapper);
    const panel = qInjectedPanel(wrapper);
    if (!btn || !panel) return;
    setPanelHeightVar(panel);
    setOpen(btn, panel, true);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      setOpen(btn, panel, !isOpen);
    });
  }

  /* ============================== Data (OpenRouter) ============================== */
  const formatNumber = (num) => {
    const n = Number(num);
    if (!Number.isFinite(n)) return '';
    return n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n);
  };

  const normalizeModelName = (name) => {
    if (!name) return '';
    const special = ['online-help', 'ux-interviews', 'internal-confluence'];
    if (special.includes(name)) return name;
    return name.includes('/') ? name : `openai/${name}`;
  };

  const isSpecialModel = (name) =>
    name === 'online-help' || name === 'ux-interviews' || name === 'internal-confluence';

  function specialModelText(name) {
    if (name === 'online-help') {
      return `*Description*
The PlunetBot Online Help uses Retrieval Augmented Generation technology. While it does not support interactive conversations, it can provide answers to any questions you have. The information from our online help is updated every two weeks.`;
    }
    if (name === 'internal-confluence') {
      return `*Description*
The PlunetBot Internal Confluence uses Retrieval Augmented Generation technology. While it does not support interactive conversations, it can provide answers to any questions you have. The information from our internal confluence is updated every two weeks. The data is limited to public spaces and not user-specific.`;
    }
    // ux-interviews
    return `*Description*
The UXResearchBot (running on Claude 3.5 Haiku) uses the interviews conducted by the UX Team and stored in Confluence. The Bot works as an agent with multiple tools including sentiment analysis, segemental differentiation, and more.

*SAMPLE Single Interview questions:*
Please give me a concise summary of the meeting with the customer Trustpoint
Tell me what Trustpoint says about the vendor assignment
What is the overall sentiment of Trustpoint?
List all pain points for Trustpoint!
List all feature requests for Trustpoint
Give me all the things that Trustpoint was happy with.

*SAMPLE Multiple Interviews questions:*
Give me the sentiment across all interviews regarding job assignment including a summary of what was said, the video link and the time
Give me a summary of what customers in segment 3 said about integrations
Give me a list with all interviews with an overall negative sentiment`;
  }

  const mdLiteToHTML = (text) =>
    (text || '')
      .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="text-text-secondary underline" href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\n/g, '<br>');

  async function fetchRemoteModelsOnce() {
    if (state.remote || state.remoteLoading) return;
    state.remoteLoading = true;
    try {
      const res = await fetch(state.cfg.OPENROUTER_MODELS_URL, { credentials: 'omit' });
      state.remote = await res.json();
      state.remoteError = null;
    } catch (e) {
      state.remoteError = e;
      console.error('[ModelInfoPanel] OpenRouter fetch error:', e);
    } finally {
      state.remoteLoading = false;
    }
  }

  const ensureDataFetches = () => { fetchRemoteModelsOnce(); };

  const lookupRemoteModel = (normalizedName) => {
    const list = state.remote?.data;
    if (!Array.isArray(list)) return null;
    return list.find(m => m?.id === normalizedName) || null;
  };

  function renderFromRemote(model) {
    if (!model) return null;
    const top = model.top_provider || {};
    const pricing = model.pricing || {};
    if (!top.max_completion_tokens) top.max_completion_tokens = top.context_length;

    const pricingPrompt = Number(pricing.prompt) ? (Number(pricing.prompt) * 1_000_000).toFixed(2) : null;
    const pricingCompletion = Number(pricing.completion) ? (Number(pricing.completion) * 1_000_000).toFixed(2) : null;
    const maxContext = formatNumber(top.context_length);
    const maxCompletion = formatNumber(top.max_completion_tokens);
    const description = model.description || '';

    let text = '';
    if (pricingPrompt && pricingCompletion) {
      text += `*Pricing*
Prompt: ${pricingPrompt} USD per 1M token
Completion: ${pricingCompletion} USD per 1M token

`;
    }
    if (maxContext || maxCompletion) {
      text += `*Token Window*
Max Context: ${maxContext || '-'}
Max Completion: ${maxCompletion || '-'}

`;
    }
    text += `*Description*
${description}`;

    return mdLiteToHTML(text);
  }

  function buildModelHTML(rawModelName) {
    const modelName = (rawModelName || '').trim();
    if (!modelName) return 'Model details not found.';

    if (isSpecialModel(modelName)) {
      return mdLiteToHTML(specialModelText(modelName));
    }

    const normalized = normalizeModelName(modelName);
    const remoteModel = lookupRemoteModel(normalized);
    if (remoteModel) {
      const html = renderFromRemote(remoteModel);
      if (html) return html;
    }

    if (state.remoteLoading) return 'Loading model details…';
    return 'Model details not found.';
  }

  /* ============================== Agents/Plugins helpers ============================== */
  function ensureAgentsMenuIsLast(force = false) {
    const now = performance.now();
    if (!force && (now - state.lastAgentsReorderAt) < state.cfg.AGENTS_REORDER_MIN_MS) return;

    const el = document.getElementById(state.cfg.AGENTS_MENU_ID);
    if (!el) return;

    const parent = el.parentElement;
    if (!parent) return;

    const divs = parent.querySelectorAll(':scope > div');
    if (!divs.length) return;

    const lastDiv = divs[divs.length - 1];
    if (lastDiv !== el) parent.appendChild(el);

    state.lastAgentsReorderAt = now;
  }

  function hidePluginsMenuIfVisible(force = false) {
    const now = performance.now();
    if (!force && (now - state.lastPluginsHideAt) < state.cfg.PLUGINS_HIDE_MIN_MS) return;

    const el = document.getElementById(state.cfg.PLUGINS_MENU_ID);
    if (!el) return;

    // Cheap visibility check; we only write if it looks visible
    const rect = el.getBoundingClientRect();
    const isShown = el.style.display !== 'none' && (rect.width > 0 || rect.height > 0);
    if (isShown) el.style.display = 'none';

    state.lastPluginsHideAt = now;
  }

  /* ============================== Mount / Unmount ============================== */
  function mountInjection() {
    const nav = qNav();
    if (!nav || !isNavOpen(nav)) return;
    if (qInjection()) return;

    const firstVertical = nav.querySelector('div[data-orientation="vertical"]');
    if (!firstVertical) return;

    const wrapper = buildInjection();
    firstVertical.parentNode.insertBefore(wrapper, firstVertical);
    bindToggle(wrapper);
  }

  function unmountInjection() {
    const existing = qInjection();
    if (existing) existing.remove();
  }

  /* ============================== Content Sync ============================== */
  const readSourceModelName = () => (qSourceSpan()?.textContent || '').trim();

  function syncInjectedContent() {
    const wrapper = qInjection();
    if (!wrapper) return;

    const contentEl = qInjectedContent(wrapper);
    if (!contentEl) return;

    const modelName = readSourceModelName();
    const html = buildModelHTML(modelName);

    if (modelName !== state.lastModelName || html !== state.lastHTML) {
      state.lastModelName = modelName;
      state.lastHTML = html;
      contentEl.innerHTML = html;

      const panel = qInjectedPanel(wrapper);
      const btn = qInjectedButton(wrapper);
      if (panel && btn && btn.getAttribute('aria-expanded') === 'true') {
        setPanelHeightVar(panel);
      }
    }
  }

  /* ============================== Orchestration ============================== */
  function tick() {
    try {
      ensureDataFetches(); // non-blocking

      const nav = qNav();
      const open = !!nav && isNavOpen(nav);

      if (open && !state.wasOpen) {
        // Transition: closed -> open
        mountInjection();
        syncInjectedContent();
        ensureAgentsMenuIsLast(true);  // force once on opening
        hidePluginsMenuIfVisible(true); // force hide once on opening
      } else if (open) {
        // Subsequent open ticks (throttled helpers)
        mountInjection();
        syncInjectedContent();
        ensureAgentsMenuIsLast();
        hidePluginsMenuIfVisible();
      } else {
        // Closed
        unmountInjection();
      }

      state.wasOpen = open;
    } catch (err) {
      console.error('[ModelInfoPanel] tick error:', err);
    }
  }

  function start() {
    if (state.intervalId) return; // already running
    tick();
    state.intervalId = setInterval(tick, state.cfg.POLL_MS);
  }

  function stop() {
    if (state.intervalId) clearInterval(state.intervalId);
    state.intervalId = null;
  }

  function configure(overrides = {}) {
    const allowed = Object.keys(DEFAULT_CFG);
    for (const k of Object.keys(overrides)) {
      if (allowed.includes(k)) state.cfg[k] = overrides[k];
    }
  }

  /* ============================== Export API ============================== */
  window.ModelInfoPanel = { start, stop, configure, state };

  // Auto-start if desired and the script is loaded with "defer" or after DOM ready
  if (state.cfg.AUTO_START) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
})();
