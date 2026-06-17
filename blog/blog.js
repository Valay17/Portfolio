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
