import "./styles.css";
import "./build-jam.css";

// Organizer-editable details live here so dates, duration, and links can be finalized later.
const event = {
  window: "48–72 hours",
  dates: "Dates to be announced",
  format: "Solo by default",
  registrationUrl: "",
  submissionUrl: "",
};

const ideas = [
  "small web apps", "browser games", "Discord bots", "interactive experiments",
  "generators", "visualizations", "AI agents", "strange utilities",
  "creative tools", "absurd but functional software", "whatever we forgot",
];

const judging = [
  { score: 25, title: "Originality", text: "How interesting, distinctive, or unexpected is the idea? A simple idea executed cleverly can beat a complex but generic one." },
  { score: 25, title: "Execution", text: "Does the core idea land? We look at usability, completeness, reliability, and whether the important parts actually work—not engineering ceremony." },
  { score: 25, title: "Experience / Cool Factor", text: "Is it enjoyable, impressive, memorable, funny, useful, surprising, or compelling? Serious and ridiculous projects both belong here." },
  { score: 15, title: "Effective Use of AI", text: "How well did human and model work together through prompting, debugging, prototyping, critique, design exploration, or learning on the fly? Tool price is irrelevant." },
  { score: 10, title: "Presentation", text: "Can we quickly understand what you built, why it exists, what to try, and how AI helped you make it?" },
];

const awards = [
  ["Most Cursed", "For the build that should not work, yet somehow does."],
  ["Best Polish", "Suspiciously smooth edges for one tiny weekend."],
  ["Best Idea", "The concept everyone wishes they had first."],
  ["Why Does This Exist?", "No clear answer. Full marks."],
  ["Best Beginner Build", "A brilliant first leap into making software."],
];

const rules = [
  "Build the project primarily during the challenge window.",
  "Libraries, frameworks, assets, templates, boilerplates, and open-source dependencies are welcome.",
  "Do not resubmit an existing personal project unchanged.",
  "General-purpose code and components are fine, but the submission must include meaningful new work.",
  "AI-generated code, text, art, audio, and other generated assets are allowed.",
  "You are responsible for licenses and usage rights for third-party material.",
  "Any model or tool is allowed unless organizers prohibit it before the event begins.",
  "Participation is solo by default. Organizers can update this if team entries are opened.",
  "Keep it safe to demo: no malware, credential theft, intentionally destructive behavior, or similar harmful functionality.",
  "Submit something demonstrable—not source code alone.",
  "Organizers may make reasonable judgment calls for edge cases or obvious rule exploits.",
  "The spirit of the competition matters more than finding loopholes.",
];

const app = document.querySelector("#app");

app.innerHTML = `
  <header class="site-header jam-header">
    <a class="brand" href="./index.html" aria-label="Open Model Room home">
      <img src="./open-model-room-mark.png" alt="" />
      <span><strong>Open Model Room</strong><small>many companions, one room</small></span>
    </a>
    <nav aria-label="Build Jam navigation">
      <a href="#about">About</a><a href="#how">Format</a><a href="#judging">Judging</a><a href="#rules">Rules</a><a href="#submission">Submit</a>
    </nav>
    <a class="header-back" href="./index.html">Back to the room ↗</a>
  </header>

  <main id="main">
    <section class="jam-hero section" id="top">
      <div class="jam-hero-copy">
        <span class="eyebrow">A tiny community building spree</span>
        <h1>Open Model Room <em>Build Jam</em></h1>
        <p class="jam-declaration">Build something people want to see, try, or talk about.</p>
        <p class="hero-lead">You get a small window, whatever AI tools you already have, and permission to make something useful, artistic, experimental, funny, weird, interactive, or completely cursed.</p>
        <div class="hero-actions">
          <a class="button primary" href="#how">How it works</a>
          <a class="button secondary" href="#eligibility">Yes, beginners count</a>
        </div>
      </div>
      <aside class="jam-ticket" aria-label="Event at a glance">
        <span class="ticket-label">Build window</span><strong>${event.window}</strong>
        <div class="ticket-rule"></div>
        <p>${event.dates}</p><p>${event.format}</p><p>Any AI tool · any stack</p>
        <span class="ticket-stamp">SMALL<br />&amp; WEIRD</span>
      </aside>
      <div class="jam-marquee" aria-label="Example project ideas">
        ${ideas.map((idea) => `<span>${idea}</span>`).join("")}
      </div>
    </section>

    <section class="section jam-about" id="about">
      <div class="section-heading"><span class="eyebrow">First: what this is not</span><h2>Not a traditional programming competition.</h2></div>
      <div class="about-layout">
        <p class="about-lead">You are <strong>not</strong> judged on hand-written code quality, clever algorithms, expensive tooling, or how long you have called yourself a developer.</p>
        <div class="plain-card"><span aria-hidden="true">✦</span><p>This is a creativity-and-execution challenge. Make a small thing. Get it working. Let people experience it.</p></div>
      </div>
      <div class="workflow-strip">
        <strong>Use what you have:</strong>
        <span>normal chat interfaces</span><span>coding agents</span><span>IDE assistants</span><span>local models</span><span>free-tier tools</span><span>copy AI-generated code into an editor by hand</span>
      </div>
    </section>

    <section class="section jam-how" id="how">
      <div class="section-heading centered"><span class="eyebrow">How it works</span><h2>Keep the scope delightfully tiny.</h2><p>The expected build window is <strong>${event.window}</strong>. At the end, show something another human can actually see or test.</p></div>
      <div class="jam-steps">
        <article><span>01</span><h3>Pick one interesting idea</h3><p>Useful, strange, beautiful, chaotic—just give it a clear center.</p></article>
        <article><span>02</span><h3>Build with AI assistance</h3><p>Prompt, prototype, debug, remix, learn, and keep the human in the loop.</p></article>
        <article><span>03</span><h3>Make it demonstrable</h3><p>A runnable build, hosted demo, or short recording when deployment is impractical.</p></article>
      </div>
      <blockquote class="scope-quote">“If your project needs a roadmap, it is probably too big.”</blockquote>
      <div class="submission-types" aria-label="Valid submission types">${["Web app", "Game", "Bot", "Executable app", "Interactive prototype", "Hosted demo", "Recorded demo"].map((item) => `<span>${item}</span>`).join("")}</div>
      <p class="center-note">Source code alone is not a complete submission. We want to witness the thing.</p>
    </section>

    <section class="section eligibility" id="eligibility">
      <div class="eligibility-card">
        <span class="eyebrow">Who can participate?</span><h2>You. Yes, probably you.</h2>
        <p>No professional programming experience is required. Beginners are explicitly welcome, and using AI to bridge a technical knowledge gap is part of the point.</p>
        <ul class="check-list">
          <li>AI-generated code is allowed</li><li>Hand-written code is allowed</li><li>Mixed workflows are allowed</li><li>No required language or framework</li><li>No required model or IDE</li><li>No required operating system</li>
        </ul>
        <p class="eligibility-note">Use whatever tools you already have. Experience and access to expensive tools are not judging criteria; creativity and execution are.</p>
      </div>
    </section>

    <section class="section judging-section" id="judging">
      <div class="section-heading"><span class="eyebrow">The serious scoreboard</span><h2>Judging</h2><p>We score the thing people experience and the process that got it there—not your ability to cosplay as a large software department.</p></div>
      <div class="judging-list">
        ${judging.map((item, index) => `<article class="judging-card" style="--score:${item.score};--delay:${index * 55}ms"><div class="score"><strong>${item.score}</strong><span>%</span></div><div><h3>${item.title}</h3><p>${item.text}</p><div class="score-bar" aria-hidden="true"><span></span></div></div></article>`).join("")}
      </div>
      <p class="model-note"><strong>Effective AI use ≠ more AI.</strong> We do not reward using more models, newer models, or more expensive models.</p>
    </section>

    <section class="section awards-section" id="awards">
      <div class="awards-heading"><span class="eyebrow">Bonus nonsense</span><h2>Community awards</h2><p>Honorary, highly prestigious, and worth exactly zero scoring points.</p></div>
      <div class="award-grid">${awards.map(([title, text], index) => `<article><span aria-hidden="true">${["☠", "✦", "◇", "?", "↗"][index]}</span><h3>${title}</h3><p>${text}</p></article>`).join("")}</div>
    </section>

    <section class="section rules-section" id="rules">
      <div class="section-heading"><span class="eyebrow">Competition bases</span><h2>Rules, without the tiny print.</h2><p>Be inventive. Be fair. Do not make the demo laptop catch fire.</p></div>
      <ol class="rule-list">${rules.map((rule, index) => `<li><span>${String(index + 1).padStart(2, "0")}</span><p>${rule}</p></li>`).join("")}</ol>
      <blockquote class="rules-quote">Don’t optimize for loopholes. Optimize for making something cool.</blockquote>
    </section>

    <section class="section mystery-section" id="mystery">
      <div class="mystery-card">
        <div class="mystery-mark" aria-hidden="true">?</div>
        <div><span class="eyebrow">Optional event twist</span><h2>Mystery Constraint</h2><p>The organizer may reveal one small surprise requirement for everyone to work into their project somehow. If enabled, it should bend the idea—not break it.</p>
        <p class="example-label">Examples only:</p><div class="constraint-list"><span>include a duck somewhere</span><span>react to the current time</span><span>add one completely unnecessary feature</span><span>include an unexpected interaction</span><span>keep one creative decision made by AI</span></div></div>
      </div>
    </section>

    <section class="section submission-section" id="submission">
      <div class="section-heading"><span class="eyebrow">The finish line</span><h2>Submission &amp; demo</h2><p>Give us the shortest path from “what is this?” to “oh, that’s neat.”</p></div>
      <div class="submission-grid">
        <article class="submit-card"><h3>Send these</h3><ul><li>Project name</li><li>One-sentence description</li><li>Link, runnable build, or demo</li><li>Short explanation of AI tools used</li><li><em>Optional:</em> source repository</li><li><em>Optional:</em> screenshots or a short video</li></ul>${event.submissionUrl ? `<a class="button primary" href="${event.submissionUrl}">Submit project</a>` : `<span class="pending-link">Submission link coming soon</span>`}</article>
        <article class="demo-card"><div class="demo-time"><strong>≈90</strong><span>seconds</span></div><h3>The ideal live demo</h3><ol><li>What I built</li><li>Show it working</li><li>What AI helped with</li><li>One interesting thing that happened</li></ol></article>
      </div>
    </section>

    <section class="section prize-section" id="prize">
      <div class="prize-copy"><span class="eyebrow">The prize</span><h2>A little fuel for the next build.</h2><p>The winner receives <strong>access to a nan.builders subscription until the end of September.</strong></p><p>The organizer has unused subscription capacity and would rather give it to someone in the community who will actually use it. Simple as that.</p></div>
      <div class="prize-badge" aria-hidden="true"><span>USE IT<br />TO MAKE<br />A THING</span><b>✦</b></div>
    </section>

    <section class="section final-cta jam-final">
      <img src="./open-model-room-mark.png" alt="" />
      <div><span class="eyebrow">Ready when the clock starts</span><h2>Build something weird. Make it work. Show us.</h2><p>${event.dates}. Registration and submission details will appear here when organizers confirm them.</p></div>
      ${event.registrationUrl ? `<a class="button primary" href="${event.registrationUrl}">Join the Build Jam</a>` : `<span class="button primary button-placeholder" aria-label="Registration link coming soon">Join link coming soon</span>`}
    </section>
  </main>

  <footer class="site-footer"><div><strong>Open Model Room Build Jam</strong><p>Technically curious internet people making cool little things together.</p></div><div><a href="./index.html">Open Model Room</a><a href="https://github.com/ajaniramon/open-model-room-harness">GitHub</a><a href="#top">Back to top ↑</a></div></footer>
`;

const observer = new IntersectionObserver(
  (entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add("visible")),
  { threshold: 0.1 },
);
document.querySelectorAll(".jam-steps article, .judging-card, .rule-list li").forEach((item) => observer.observe(item));
