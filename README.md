# Portfolio Website - https://valay17.github.io/Portfolio/

This is the repository for my personal portfolio website, where I showcase my skills, projects, and experience. The website is designed to highlight my work as a developer and provide a user-friendly experience for anyone visiting to learn more about the projects I've worked on.

## Features

- **Transparency, Shrink, and Sticky Navbar:** The navbar remains fixed at the top, shrinks when scrolling, and has a transparent effect when at the top of the page.
- **Dark/Light Theme:** A toggle feature allowing users to switch between dark and light modes. Important for my fellow Dark Mode Devs!
- **Responsive Mobile & Desktop Views:** The website adjusts its layout to ensure an optimal viewing experience across devices, from mobile phones to desktops.
- **Click Listener for Menubar:** A click listener is added to close the menu bar when clicking anywhere outside of the navigation, improving the overall user experience. This eliminates the need for users to click the close/cross button, which can often be annoying and adds an extra step.
- **Scroll to Top:** A button that appears when you scroll down the page, allowing users to quickly return to the top.
- **GitHub Linked Projects:** Links to my GitHub repositories from individual project sections for users to view the code behind each project.
- **Hyperlinks:** Links to external websites and sections within the portfolio for easy navigation.
- **Resume Download:** A button that allows users to download my resume directly from the website.
- **GitHub/LinkedIn Hyperlinks:** Direct links to my GitHub and LinkedIn profiles for easy access.
- **Hover Features:** Interactive hover effects for buttons, links, and project cards to improve user engagement.
- **Favicon Added:** A custom favicon that appears in the browser tab for easy site identification.
- **Dynamic Column Layout:** The project list changes from a 3-column layout to a 1-column layout when viewed on mobile, improving accessibility and usability.
- **Email Button:** A button that opens the user's default email client to easily send me an email.
- **Blog:** A Jekyll-powered technical blog at `/blog/` covering C++ internals, low-level systems, and performance engineering. Posts are written in Markdown and deployed automatically via GitHub Actions. The listing page includes domain-based filtering.
- **Cross-Post Deep Links:** Posts can link to a specific section of another post. Arriving via such a link scrolls to the section and briefly highlights the target heading (handled in `blog/blog.js` + `blog/blog.css`, so every post gets it for free).
- **Blog Search:** Full-text search over all posts on the blog index, powered by [Pagefind](https://pagefind.app/). The search index is built in CI and served as static files — no server, no external service. Press `/` to focus the search box.

## Blog authoring notes

### Linking to another post (or a section of one)

Standard Markdown links can't set `target="_blank"`, so use raw HTML inside the
Markdown for cross-post links:

```html
<a href="/blog/memory/prefaulting/#the-restriction-that-makes-it-work"
   target="_blank" rel="noopener noreferrer">prefaulting post</a>
```

- `rel="noopener noreferrer"` should always accompany `target="_blank"` (security hygiene).
- The section anchor comes from Jekyll/kramdown's automatic heading IDs:
  lowercase, spaces to hyphens, punctuation stripped. So
  `## The Restriction That Makes It Work` becomes
  `#the-restriction-that-makes-it-work`.
- The href path is the target post's `permalink` from its front matter.

### Search (Pagefind)

Search is fully static and runs entirely in the browser:

- `_layouts/post.html` marks the indexable region with `data-pagefind-body` on
  the `<article>`, tags `domain` as a filter + meta field, and exposes `title`
  and `date` as meta. Nav, the back link, and the Links section are excluded
  with `data-pagefind-ignore`. Only posts are indexed — pages without
  `data-pagefind-body` (the portfolio home, the blog index) are skipped.
- `.github/workflows/deploy.yml` runs `npx pagefind --site _site` after the
  Jekyll build, writing the index to `_site/pagefind/`, which ships in the Pages
  artifact.
- `blog/blog.js` lazy-loads `pagefind.js` on first focus and renders results
  into the blog index. Bundle path and `baseUrl` are passed from Liquid via
  `data-pf-*` attributes so it works under the `/portfolio/` project-page path.

**Requires the Pages source to be "GitHub Actions"** (Settings → Pages). The
classic "Deploy from a branch" build can't run Pagefind, so search would go
stale if it were switched.

To preview search locally you must build and index, then serve `_site`:

```bash
bundle exec jekyll build
npx pagefind --site _site
npx pagefind --site _site --serve   # or any static server pointed at _site
```

Plain `jekyll serve` will not have a search index (the box falls back to an
"unavailable" message).

## Technologies Used

This website is built using the following technologies:

- **Frontend:**
  - HTML
  - CSS
  - JavaScript
- **Blog:**
  - Jekyll (static site generator)
  - Markdown (post authoring)
  - Rouge (syntax highlighting)
  - GitHub Actions (automated build and deploy)
- **Version Control:**
  - Git
  - GitHub (for hosting and version control)

## License

This project is not licensed. No rights are granted to use, modify, distribute, or otherwise use the code in this repository unless explicitly stated otherwise. By using or accessing the repository, you acknowledge that you are not being granted any rights or licenses to the content or code.
