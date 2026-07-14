document.documentElement.classList.add("js");

const root = document.documentElement;
const languageButton = document.querySelector("[data-language-toggle]");
const languageLabel = document.querySelector("[data-language-label]");
const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");

function preferredLanguage() {
  try {
    const stored = window.localStorage.getItem("status-orbit.site-language");
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // The site remains usable when browser storage is unavailable.
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function setLanguage(language) {
  const next = language === "en" ? "en" : "zh";
  root.dataset.language = next;
  root.lang = next === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-zh][data-en]").forEach((element) => {
    element.textContent = element.dataset[next] ?? element.textContent;
  });
  document.querySelectorAll("[data-aria-zh][data-aria-en]").forEach((element) => {
    element.setAttribute("aria-label", element.dataset[`aria${next === "zh" ? "Zh" : "En"}`]);
  });
  if (languageLabel) languageLabel.textContent = next === "zh" ? "EN" : "中文";
  const guidePage = document.body.classList.contains("guide-page");
  document.title = next === "zh"
    ? guidePage ? "StatusOrbit 使用指南" : "StatusOrbit — 电脑变慢，空间不足，原因一眼看清"
    : guidePage ? "StatusOrbit User Guide" : "StatusOrbit — Find slowdowns and free up space";
  try {
    window.localStorage.setItem("status-orbit.site-language", next);
  } catch {
    // Language still applies for the current page.
  }
}

setLanguage(preferredLanguage());

languageButton?.addEventListener("click", () => {
  setLanguage(root.dataset.language === "zh" ? "en" : "zh");
});

function closeNavigation() {
  nav?.classList.remove("is-open");
  navToggle?.setAttribute("aria-expanded", "false");
}

navToggle?.addEventListener("click", () => {
  const expanded = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!expanded));
  nav?.classList.toggle("is-open", !expanded);
});

nav?.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeNavigation));
window.addEventListener("resize", () => {
  if (window.innerWidth > 760) closeNavigation();
});

function updateHeader() {
  header?.classList.toggle("is-scrolled", window.scrollY > 16);
}
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

document.querySelectorAll("[data-year]").forEach((element) => {
  element.textContent = String(new Date().getFullYear());
});

const revealElements = [...document.querySelectorAll("[data-reveal]")];
revealElements.forEach((element) => {
  const delay = Number(element.dataset.delay ?? 0);
  element.style.setProperty("--reveal-delay", `${Math.max(0, delay)}ms`);
});

if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-revealed");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.08 });
  revealElements.forEach((element) => revealObserver.observe(element));
} else {
  revealElements.forEach((element) => element.classList.add("is-revealed"));
}

const guideLinks = [...document.querySelectorAll(".guide-sidebar nav a")];
const guideSections = guideLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

if (guideSections.length > 0) {
  let scrollFrame;

  function setActiveGuideSection(section) {
    guideLinks.forEach((link) => {
      const active = link.getAttribute("href") === `#${section.id}`;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }

  function updateActiveGuideSection() {
    scrollFrame = undefined;
    const marker = Math.min(180, window.innerHeight * 0.24);
    let activeSection = guideSections[0];

    guideSections.forEach((section) => {
      if (section.getBoundingClientRect().top <= marker) activeSection = section;
    });

    const atPageEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    if (atPageEnd) activeSection = guideSections[guideSections.length - 1];
    setActiveGuideSection(activeSection);
  }

  function scheduleGuideUpdate() {
    if (scrollFrame !== undefined) return;
    scrollFrame = window.requestAnimationFrame(updateActiveGuideSection);
  }

  guideLinks.forEach((link) => {
    link.addEventListener("click", () => {
      const section = document.querySelector(link.getAttribute("href"));
      if (section) setActiveGuideSection(section);
    });
  });

  updateActiveGuideSection();
  window.addEventListener("scroll", scheduleGuideUpdate, { passive: true });
  window.addEventListener("resize", scheduleGuideUpdate);
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const code = button.parentElement?.querySelector("code")?.textContent ?? "";
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = root.dataset.language === "zh" ? "已复制" : "Copied";
      window.setTimeout(() => {
        button.textContent = root.dataset.language === "zh" ? "复制" : "Copy";
      }, 1400);
    } catch {
      button.textContent = root.dataset.language === "zh" ? "复制失败" : "Copy failed";
    }
  });
});
