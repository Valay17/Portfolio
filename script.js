function toggleMenu() {
  const menu = document.querySelector(".menu-links");
  const icon = document.querySelector(".hamburger-icon");
  
  // Toggle the "open" class for the menu and icon
  menu.classList.toggle("open");
  icon.classList.toggle("open");

  // If the menu is opened, add an event listener for closing it when clicking outside
  if (menu.classList.contains("open")) {
    document.addEventListener("click", closeMenuOutside);
  } else {
    document.removeEventListener("click", closeMenuOutside);
  }
}

// Function to close the menu if clicked outside
function closeMenuOutside(event) {
  const menu = document.querySelector(".menu-links");
  const icon = document.querySelector(".hamburger-icon");
  const menuContainer = document.querySelector(".hamburger-menu");

  // Check if the click was outside the menu and hamburger icon
  if (!menuContainer.contains(event.target)) {
    // Close the menu by removing the "open" class
    menu.classList.remove("open");
    icon.classList.remove("open");

    // Remove the event listener to stop listening for outside clicks
    document.removeEventListener("click", closeMenuOutside);
  }
}

const scrollToTopBtn = document.getElementById("scrollToTopBtn");

// Listen for the scroll event to show the button when the user scrolls down even slightly
window.addEventListener("scroll", () => {
  if (window.scrollY > 10) { // Any scroll, even a small amount, will show the button
    scrollToTopBtn.classList.add("show");
  } else {
    scrollToTopBtn.classList.remove("show"); // Hide the button when at the top
  }
});

// Scroll to top when the button is clicked
scrollToTopBtn.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// Shrink navbar on scroll
const navbar = document.querySelector('nav');

// Listen for the scroll event
window.addEventListener('scroll', () => {
  const hamburgerIcon = document.querySelector('.hamburger-icon');
  
  if (window.scrollY > 100) {  // You can change the scroll position threshold
    navbar.classList.add('shrink');
    hamburgerIcon.classList.add('shrink');  // Apply shrink to hamburger icon as well
  } else {
    navbar.classList.remove('shrink');
    hamburgerIcon.classList.remove('shrink');  // Remove shrink effect
  }
});

// Dark / Light Mode toggle

const btn = document.getElementById("modeToggle");
const btn2 = document.getElementById("modeToggle2");
const themeIcons = document.querySelectorAll(".icon");
const currentTheme = localStorage.getItem("theme");

if (currentTheme === "dark") {
  setLightMode();
}

btn.addEventListener("click", function () {
  setTheme();
});

btn2.addEventListener("click", function () {
  setTheme();
});

function setTheme() {
  let currentTheme = document.body.getAttribute("theme");

  if (currentTheme === "light") {
    setDarkMode();
  } else {
    setLightMode();
  }
}

function setDarkMode() {
  document.body.removeAttribute("theme");
  localStorage.setItem("theme", "dark");

  themeIcons.forEach((icon) => {
    icon.src = icon.getAttribute("src-dark");
  });
}

function setLightMode() {
  document.body.setAttribute("theme", "light");
  localStorage.setItem("theme", "light");

  themeIcons.forEach((icon) => {
    icon.src = icon.getAttribute("src-light");
  });
}

// Repo

// Define GitHub repository URLs and custom names
const repos = [
  { repo: 'Valay17/SIPHI--Speech-Improvement-for-People-with-Hearing-Impairment-using-Visual-Aid', customName: 'SIPHI – Speech Improvement for People with Hearing Impairment using Visual Aid' }, // Custom name for this repository
  { repo: 'Valay17/MIBA--Mobile-Image-Based-Authentication-on-Android-Devices', customName: 'MIBA – Mobile Image-Based Authentication on Android Devices' }, // Custom name
  { repo: 'Valay17/DISHA--Deep-Learning-based-Cyclone-Intensity-Estimation-with-NLP-based-Report-Generation', customName: 'DISHA - Deep Learning based Cyclone Intensity Estimation with NLP based Report Generation' }  // Custom name
];

// Function to fetch repository data from GitHub API and place it in a specified container
async function fetchRepoData(repoInfo, targetId) {
  try {
    const url = `https://api.github.com/repos/${repoInfo.repo}`;
    const response = await fetch(url);

    // Check if the response is successful
    if (!response.ok) {
      if (response.status === 404) {
        // If repository is not found, show custom message with repoInfo.customName
        const targetContainer = document.getElementById(targetId);
        if (!targetContainer) {
          throw new Error(`Container with ID ${targetId} not found.`);
        }

        const errorItem = document.createElement('div');
        errorItem.classList.add('repo-item');
        errorItem.innerHTML = `
          <h2>Repository: ${repoInfo.customName}</h2>
          <p>Repository not found or another issue occurred.</p>
        `;
        targetContainer.appendChild(errorItem);
        return; // Stop further processing if repository is not found
      }
      throw new Error('Repository not found');
    }

    const data = await response.json();

    // Find the target container by ID
    const targetContainer = document.getElementById(targetId);
    if (!targetContainer) {
      throw new Error(`Container with ID ${targetId} not found.`);
    }

    // Create a div element for each repository and insert the content directly
    const repoItem = document.createElement('div');
    repoItem.classList.add('repo-item');  // Apply the same styling class

    repoItem.innerHTML = `
      <h2><a href="${data.html_url}" target="_blank">${repoInfo.customName}</a></h2>
    `;

    // Append the repository content directly to the specified target container
    targetContainer.appendChild(repoItem);

  } catch (error) {
    // Handle other errors (e.g., network issue)
    const targetContainer = document.getElementById(targetId);
    if (!targetContainer) {
      throw new Error(`Container with ID ${targetId} not found.`);
    }

    const errorItem = document.createElement('div');
    errorItem.classList.add('repo-item');
    errorItem.innerHTML = `
      <h2>Repository: ${repoInfo.customName}</h2>
      <p>Repository not found or another issue occurred.</p>
    `;
    targetContainer.appendChild(errorItem);
  }
}

// Call the fetchRepoData function for each repository, specifying where to place the content
fetchRepoData({ repo: 'Valay17/SIPHI--Speech-Improvement-for-People-with-Hearing-Impairment-using-Visual-Aid', customName: 'SIPHI – Speech Improvement for People with Hearing Impairment using Visual Aid' }, 'repo-section-1'); 
fetchRepoData({ repo: 'Valay17/MIBA--Mobile-Image-Based-Authentication-on-Android-Devices', customName: 'MIBA – Mobile Image-Based Authentication on Android Devices' }, 'repo-section-2');
fetchRepoData({ repo: 'Valay17/DISHA--Deep-Learning-based-Cyclone-Intensity-Estimation-with-NLP-based-Report-Generation', customName: 'DISHA - Deep Learning based Cyclone Intensity Estimation with NLP based Report Generation' }, 'repo-section-3');
