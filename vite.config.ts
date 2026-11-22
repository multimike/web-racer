// Only a relative base, so a production build also boots from a sub-folder
// (GitHub Pages project site, itch.io, https://host/some/folder/). `npx vite
// build` still emits index.html only: the labs (*.html) stay dev-server pages.
export default { base: './' };
