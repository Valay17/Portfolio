function toggleMenu() {
  const menu = document.querySelector(".menu-links");
  const icon = document.querySelector(".hamburger-icon");
  menu.classList.toggle("open");
  icon.classList.toggle("open");
  if (menu.classList.contains("open")) {
    document.addEventListener("click", closeMenuOutside);
  } else {
    document.removeEventListener("click", closeMenuOutside);
  }
}

function closeMenuOutside(event) {
  const menu = document.querySelector(".menu-links");
  const icon = document.querySelector(".hamburger-icon");
  const menuContainer = document.querySelector(".hamburger-menu");
  if (!menuContainer.contains(event.target)) {
    menu.classList.remove("open");
    icon.classList.remove("open");
    document.removeEventListener("click", closeMenuOutside);
  }
}

// Scroll to top
const scrollToTopBtn = document.getElementById("scrollToTopBtn");
window.addEventListener("scroll", () => {
  scrollToTopBtn.classList.toggle("show", window.scrollY > 10);
});
scrollToTopBtn.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// Navbar shrink on scroll
const navbar = document.querySelector("nav");
window.addEventListener("scroll", () => {
  const hamburgerIcon = document.querySelector(".hamburger-icon");
  const shrink = window.scrollY > 100;
  navbar.classList.toggle("shrink", shrink);
  if (hamburgerIcon) hamburgerIcon.classList.toggle("shrink", shrink);
});

// Dark / Light mode — shares localStorage key with portfolio
const btn = document.getElementById("modeToggle");
const btn2 = document.getElementById("modeToggle2");
const themeIcons = document.querySelectorAll(".color-icon");
const currentTheme = localStorage.getItem("theme");

if (currentTheme === "light") {
  setLightMode();
}

if (btn) btn.addEventListener("click", setTheme);
if (btn2) btn2.addEventListener("click", setTheme);

function setTheme() {
  if (document.body.getAttribute("theme") === "light") {
    setDarkMode();
  } else {
    setLightMode();
  }
}

function setDarkMode() {
  document.body.removeAttribute("theme");
  localStorage.setItem("theme", "dark");
  themeIcons.forEach((icon) => { icon.src = icon.getAttribute("src-dark"); });
}

function setLightMode() {
  document.body.setAttribute("theme", "light");
  localStorage.setItem("theme", "light");
  themeIcons.forEach((icon) => { icon.src = icon.getAttribute("src-light"); });
}

// Domain filtering (blog index only)
const filterBtns = document.querySelectorAll(".filter-btn");
const postEntries = document.querySelectorAll(".post-entry");

function applyFilter(domain) {
  filterBtns.forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === domain);
  });
  postEntries.forEach((entry) => {
    const show = domain === "all" || entry.dataset.domain === domain;
    entry.style.display = show ? "" : "none";
  });
}

if (filterBtns.length) {
  // activate filter from ?domain= URL param
  const urlDomain = new URLSearchParams(window.location.search).get("domain");
  applyFilter(urlDomain || "all");

  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const filter = btn.dataset.filter;
      applyFilter(filter);
      // update URL without page reload
      const url = new URL(window.location);
      if (filter === "all") {
        url.searchParams.delete("domain");
      } else {
        url.searchParams.set("domain", filter);
      }
      window.history.replaceState({}, "", url);
    });
  });

  // domain tags inside post entries also trigger filter
  document.querySelectorAll(".post-entry .domain-tag").forEach((tag) => {
    tag.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const domain = tag.dataset.filter;
      applyFilter(domain);
      const url = new URL(window.location);
      url.searchParams.set("domain", domain);
      window.history.replaceState({}, "", url);
    });
  });
}

// Deep-link highlight (post pages only) — when the page is opened at a #section
// anchor, such as a cross-post link from another article, briefly highlight the
// target heading so the reader sees which section was linked. Scroll-to-section
// itself is native browser behaviour; this only adds the visual cue.
(function () {
  const container = document.querySelector(".post-body-content");
  if (!container) return;

  function highlightHash() {
    if (!window.location.hash) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    const target = id && document.getElementById(id);
    if (!target || !container.contains(target)) return;

    // Restart the animation if the same anchor is activated again.
    target.classList.remove("hash-target-highlight");
    void target.offsetWidth; // force reflow so the animation replays
    target.addEventListener(
      "animationend",
      () => target.classList.remove("hash-target-highlight"),
      { once: true }
    );
    target.classList.add("hash-target-highlight");
  }

  if (window.location.hash) {
    // Let the browser's native scroll settle first.
    window.addEventListener("load", () => setTimeout(highlightHash, 60));
  }
  window.addEventListener("hashchange", highlightHash);
})();

// ─── BLOG SEARCH (blog index only) ──────────────────────────────────────────
// Full-text search powered by Pagefind. The static index (_site/pagefind/) is
// built in CI after Jekyll and served as plain files, so this is all
// client-side — no server, works on GitHub Pages. The index is fetched lazily
// on first focus/keystroke, and only its small metadata chunk loads up front;
// per-query fragments are pulled on demand.
(function () {
  const input = document.getElementById("blogSearch");
  if (!input) return;

  const resultsEl = document.getElementById("searchResults");
  const filtersEl = document.querySelector(".domain-filters");
  const listHeaderEl = document.querySelector(".post-list-header");
  const entries = document.querySelectorAll(".post-entry");
  const emptyEl = document.querySelector(".post-list-empty");

  const bundleUrl = input.dataset.pfBundle || "/pagefind/pagefind.js";
  const baseUrl = input.dataset.pfBaseurl || "/";

  let loadPromise = null;
  let debounce;
  let currentQuery = "";

  function loadPagefind() {
    if (!loadPromise) {
      loadPromise = import(bundleUrl)
        .then(async (mod) => {
          await mod.options({ baseUrl: baseUrl });
          mod.init();
          return mod;
        })
        .catch((err) => {
          loadPromise = null; // allow a retry on the next keystroke
          throw err;
        });
    }
    return loadPromise;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function showPostList() {
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    if (filtersEl) filtersEl.hidden = false;
    if (listHeaderEl) listHeaderEl.hidden = false;
    if (emptyEl) emptyEl.hidden = false;
    // restore whatever domain filter was active before searching
    const active = document.querySelector(".filter-btn.active");
    applyFilter(active ? active.dataset.filter : "all");
  }

  function showSearchMode() {
    if (filtersEl) filtersEl.hidden = true;
    if (listHeaderEl) listHeaderEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;
    entries.forEach((e) => (e.style.display = "none"));
    resultsEl.hidden = false;
  }

  function renderResults(query, data) {
    if (!data.length) {
      resultsEl.innerHTML =
        '<p class="search-status">No posts match &ldquo;' +
        escapeHtml(query) +
        '&rdquo;.</p>';
      return;
    }

    const rows = data
      .map((d) => {
        const meta = d.meta || {};
        const domain = meta.domain || "";
        const date = meta.date || "";
        const title = meta.title || d.url;
        const subs = (d.sub_results || [])
          .filter((s) => s.url && s.url !== d.url)
          .slice(0, 3)
          .map(
            (s) =>
              '<a class="search-sub" href="' +
              encodeURI(s.url) +
              '">' +
              escapeHtml(s.title) +
              "</a>"
          )
          .join("");

        return (
          '<article class="search-result">' +
          '<a class="search-result-title" href="' +
          encodeURI(d.url) +
          '">' +
          escapeHtml(title) +
          "</a>" +
          '<div class="search-result-meta">' +
          (domain
            ? '<span class="domain-tag">' + escapeHtml(domain) + "</span>"
            : "") +
          (date
            ? '<time class="search-result-date">' + escapeHtml(date) + "</time>"
            : "") +
          "</div>" +
          '<p class="search-excerpt">' +
          d.excerpt + // Pagefind HTML-escapes this and wraps matches in <mark>
          "</p>" +
          (subs ? '<div class="search-subs">' + subs + "</div>" : "") +
          "</article>"
        );
      })
      .join("");

    resultsEl.innerHTML =
      '<p class="search-status">' +
      data.length +
      (data.length === 1 ? " result" : " results") +
      "</p>" +
      rows;
  }

  async function runSearch(query) {
    currentQuery = query;

    if (!query) {
      showPostList();
      return;
    }

    showSearchMode();
    resultsEl.innerHTML = '<p class="search-status">Searching&hellip;</p>';

    try {
      const pf = await loadPagefind();
      const search = await pf.search(query);
      if (currentQuery !== query) return; // a newer query superseded this one
      const data = await Promise.all(
        search.results.slice(0, 20).map((r) => r.data())
      );
      if (currentQuery !== query) return;
      renderResults(query, data);
    } catch (e) {
      if (currentQuery !== query) return;
      resultsEl.innerHTML =
        '<p class="search-status">Search is unavailable right now.</p>';
    }
  }

  function syncUrl(query) {
    const url = new URL(window.location);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    window.history.replaceState({}, "", url);
  }

  input.addEventListener("input", () => {
    const query = input.value.trim();
    syncUrl(query);
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(query), 180);
  });

  // warm the index as soon as the user shows intent
  input.addEventListener("focus", () => loadPagefind().catch(() => {}), {
    once: true,
  });

  // "/" focuses search (unless typing in a field already)
  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement || {}).tagName;
    if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
      e.preventDefault();
      input.focus();
    } else if (e.key === "Escape" && document.activeElement === input) {
      input.value = "";
      syncUrl("");
      runSearch("");
      input.blur();
    }
  });

  // honour a ?q= deep link on load
  const initial = new URLSearchParams(window.location.search).get("q");
  if (initial) {
    input.value = initial;
    runSearch(initial.trim());
  }
})();
