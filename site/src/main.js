import "./styles.css";
import { locales, localeNames } from "./translations.js";

const supportedLocales = Object.keys(locales);
const requestedLocale = new URLSearchParams(location.search).get("lang");
let activeLocale = supportedLocales.includes(requestedLocale)
  ? requestedLocale
  : supportedLocales.includes(localStorage.getItem("omr-locale"))
    ? localStorage.getItem("omr-locale")
    : "en";

const app = document.querySelector("#app");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cards(items, className) {
  return items
    .map(
      (item, index) => `
        <article class="${className}" style="--delay:${index * 55}ms">
          ${item.kicker ? `<span class="card-kicker">${escapeHtml(item.kicker)}</span>` : ""}
          ${item.icon ? `<span class="card-icon" aria-hidden="true">${item.icon}</span>` : ""}
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.text)}</p>
        </article>`,
    )
    .join("");
}

function render(locale) {
  const t = locales[locale];
  document.documentElement.lang = locale;
  document.title = t.metaTitle;
  document
    .querySelector('meta[name="description"]')
    .setAttribute("content", t.metaDescription);

  app.innerHTML = `
    <header class="site-header">
      <a class="brand" href="#top" aria-label="Open Model Room home">
        <img src="./open-model-room-mark.png" alt="" />
        <span><strong>Open Model Room</strong><small>${escapeHtml(t.brandLine)}</small></span>
      </a>
      <nav aria-label="${escapeHtml(t.navLabel)}">
        <a href="#features">${escapeHtml(t.nav.features)}</a>
        <a href="#how">${escapeHtml(t.nav.how)}</a>
        <a href="#install">${escapeHtml(t.nav.install)}</a>
        <a href="#security">${escapeHtml(t.nav.security)}</a>
      </nav>
      <div class="language-picker">
        <label for="locale">${escapeHtml(t.languageLabel)}</label>
        <select id="locale" aria-label="${escapeHtml(t.languageLabel)}">
          ${supportedLocales.map((code) => `<option value="${code}" ${code === locale ? "selected" : ""}>${localeNames[code]}</option>`).join("")}
        </select>
      </div>
    </header>

    <main id="main">
      <section class="hero section" id="top">
        <div class="hero-copy">
          <span class="eyebrow">${escapeHtml(t.hero.eyebrow)}</span>
          <h1>${escapeHtml(t.hero.title)} <em>${escapeHtml(t.hero.highlight)}</em></h1>
          <p class="hero-lead">${escapeHtml(t.hero.lead)}</p>
          <div class="hero-actions">
            <a class="button primary" href="https://github.com/ajaniramon/open-model-room-harness">${escapeHtml(t.hero.primary)}</a>
            <a class="button secondary" href="#install">${escapeHtml(t.hero.secondary)}</a>
          </div>
          <div class="hero-proof" aria-label="${escapeHtml(t.hero.proofLabel)}">
            ${t.hero.proofs.map((proof) => `<span>✦ ${escapeHtml(proof)}</span>`).join("")}
          </div>
        </div>
        <div class="hero-art" aria-label="${escapeHtml(t.hero.artAlt)}">
          <div class="orbit orbit-one"><span>OpenAI</span><span>Gemini</span><span>Local</span></div>
          <div class="orbit orbit-two"><span>Claude</span><span>Grok</span><span>NanoGPT</span></div>
          <div class="logo-card">
            <img src="./open-model-room-mark.png" alt="${escapeHtml(t.logoAlt)}" />
            <p>${escapeHtml(t.hero.cardLine)}</p>
          </div>
        </div>
      </section>

      <section class="intro-strip" aria-label="${escapeHtml(t.introLabel)}">
        ${t.intro.map((item) => `<div><strong>${escapeHtml(item.value)}</strong><span>${escapeHtml(item.label)}</span></div>`).join("")}
      </section>

      <section class="section providers" id="features">
        <div class="section-heading">
          <span class="eyebrow">${escapeHtml(t.providers.eyebrow)}</span>
          <h2>${escapeHtml(t.providers.title)}</h2>
          <p>${escapeHtml(t.providers.lead)}</p>
        </div>
        <div class="provider-list">
          ${t.providers.items
            .map(
              (provider) => `
              <article>
                <span class="provider-dot" style="--dot:${provider.color}"></span>
                <div><h3>${escapeHtml(provider.name)}</h3><p>${escapeHtml(provider.text)}</p></div>
              </article>`,
            )
            .join("")}
        </div>
      </section>

      <section class="section feature-section">
        <div class="section-heading centered">
          <span class="eyebrow">${escapeHtml(t.features.eyebrow)}</span>
          <h2>${escapeHtml(t.features.title)}</h2>
          <p>${escapeHtml(t.features.lead)}</p>
        </div>
        <div class="feature-grid">${cards(t.features.items, "feature-card")}</div>
      </section>

      <section class="section luca-section">
        <figure class="luca-photo">
          <img src="./luca.png" alt="${escapeHtml(t.luca.alt)}" />
          <figcaption>${escapeHtml(t.luca.caption)}</figcaption>
        </figure>
        <div class="luca-copy">
          <span class="eyebrow">${escapeHtml(t.luca.eyebrow)}</span>
          <h2>${escapeHtml(t.luca.title)}</h2>
          <p>${escapeHtml(t.luca.text)}</p>
          <blockquote>“${escapeHtml(t.luca.quote)}”</blockquote>
          <p class="small-note">${escapeHtml(t.luca.note)}</p>
        </div>
      </section>

      <section class="section how-section" id="how">
        <div class="section-heading">
          <span class="eyebrow">${escapeHtml(t.how.eyebrow)}</span>
          <h2>${escapeHtml(t.how.title)}</h2>
          <p>${escapeHtml(t.how.lead)}</p>
        </div>
        <ol class="timeline">
          ${t.how.steps
            .map(
              (step, index) => `
              <li><span>${String(index + 1).padStart(2, "0")}</span><div><h3>${escapeHtml(step.title)}</h3><p>${escapeHtml(step.text)}</p></div></li>`,
            )
            .join("")}
        </ol>
      </section>

      <section class="section architecture-section">
        <div class="section-heading centered">
          <span class="eyebrow">${escapeHtml(t.architecture.eyebrow)}</span>
          <h2>${escapeHtml(t.architecture.title)}</h2>
          <p>${escapeHtml(t.architecture.lead)}</p>
        </div>
        <div class="architecture" role="img" aria-label="${escapeHtml(t.architecture.alt)}">
          <div class="arch-node discord"><b>Discord</b><small>${escapeHtml(t.architecture.discord)}</small></div>
          <span class="arch-arrow">→</span>
          <div class="arch-node harness"><b>${escapeHtml(t.architecture.harness)}</b><small>${escapeHtml(t.architecture.policy)}</small></div>
          <span class="arch-arrow">→</span>
          <div class="arch-stack">
            <span>NanoGPT</span><span>OpenAI</span><span>Claude</span><span>Grok</span><span>Gemini</span>
          </div>
        </div>
      </section>

      <section class="section install-section" id="install">
        <div class="section-heading">
          <span class="eyebrow">${escapeHtml(t.install.eyebrow)}</span>
          <h2>${escapeHtml(t.install.title)}</h2>
          <p>${escapeHtml(t.install.lead)}</p>
        </div>
        <div class="install-grid">
          ${t.install.platforms
            .map(
              (platform) => `
              <article class="install-card">
                <span>${escapeHtml(platform.kicker)}</span>
                <h3>${escapeHtml(platform.title)}</h3>
                <p>${escapeHtml(platform.text)}</p>
                <pre><code>${escapeHtml(platform.command)}</code><button class="copy-button" type="button" data-copy="${escapeHtml(platform.command)}">${escapeHtml(t.install.copy)}</button></pre>
              </article>`,
            )
            .join("")}
        </div>
        <div class="setup-details">
          <div>
            <h3>${escapeHtml(t.install.wizardTitle)}</h3>
            <ul>${t.install.wizard.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </div>
          <div>
            <h3>${escapeHtml(t.install.discordTitle)}</h3>
            <ul>${t.install.discord.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </div>
        </div>
      </section>

      <section class="section security-section" id="security">
        <div class="security-copy">
          <span class="eyebrow">${escapeHtml(t.security.eyebrow)}</span>
          <h2>${escapeHtml(t.security.title)}</h2>
          <p>${escapeHtml(t.security.lead)}</p>
          <a class="text-link" href="https://github.com/ajaniramon/open-model-room-harness/blob/main/SECURITY.md">${escapeHtml(t.security.link)} →</a>
        </div>
        <div class="security-grid">${cards(t.security.items, "security-card")}</div>
      </section>

      <section class="section command-section">
        <div class="section-heading">
          <span class="eyebrow">${escapeHtml(t.commands.eyebrow)}</span>
          <h2>${escapeHtml(t.commands.title)}</h2>
          <p>${escapeHtml(t.commands.lead)}</p>
        </div>
        <div class="command-window">
          <div class="window-bar"><span></span><span></span><span></span><b>dev-room</b></div>
          ${t.commands.items.map((command) => `<p><strong>@JJ</strong> ${escapeHtml(command)}</p>`).join("")}
        </div>
      </section>

      <section class="section faq-section">
        <div class="section-heading centered">
          <span class="eyebrow">${escapeHtml(t.faq.eyebrow)}</span>
          <h2>${escapeHtml(t.faq.title)}</h2>
        </div>
        <div class="faq-list">
          ${t.faq.items.map((item) => `<details><summary>${escapeHtml(item.q)}</summary><p>${escapeHtml(item.a)}</p></details>`).join("")}
        </div>
      </section>

      <section class="section final-cta">
        <img src="./open-model-room-mark.png" alt="" />
        <div><span class="eyebrow">${escapeHtml(t.cta.eyebrow)}</span><h2>${escapeHtml(t.cta.title)}</h2><p>${escapeHtml(t.cta.text)}</p></div>
        <a class="button primary" href="https://github.com/ajaniramon/open-model-room-harness">${escapeHtml(t.cta.button)}</a>
      </section>
    </main>

    <footer class="site-footer">
      <div><strong>Open Model Room</strong><p>${escapeHtml(t.footer.line)}</p></div>
      <div><a href="https://github.com/ajaniramon/open-model-room-harness">GitHub</a><a href="https://github.com/ajaniramon/open-model-room-harness/blob/main/LICENSE">MIT</a><a href="#top">${escapeHtml(t.footer.top)} ↑</a></div>
    </footer>
  `;

  document.querySelector("#locale").addEventListener("change", (event) => {
    activeLocale = event.target.value;
    localStorage.setItem("omr-locale", activeLocale);
    const url = new URL(location.href);
    url.searchParams.set("lang", activeLocale);
    history.replaceState(null, "", url);
    render(activeLocale);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  document.querySelectorAll(".copy-button").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.dataset.copy);
      const previous = button.textContent;
      button.textContent = t.install.copied;
      setTimeout(() => (button.textContent = previous), 1300);
    });
  });

  const observer = new IntersectionObserver(
    (entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add("visible")),
    { threshold: 0.12 },
  );
  document.querySelectorAll(".feature-card, .timeline li, .install-card").forEach((element) =>
    observer.observe(element),
  );
}

render(activeLocale);
