// Lazy image loading: <img data-src="..."> starts loading when it comes near the screen.
// Images fade in over a placeholder; if one fails, the placeholder stays.

let observer = null;

function load(img) {
  const src = img.getAttribute('data-src');
  if (!src) return;
  img.removeAttribute('data-src');
  img.onload = () => img.classList.add('is-loaded');
  img.onerror = () => img.parentNode && img.parentNode.removeChild(img);
  img.src = src;
}

function getObserver() {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          // Chromium 53 has intersectionRatio but not yet isIntersecting.
          if (entry.intersectionRatio > 0 || entry.isIntersecting) {
            observer.unobserve(entry.target);
            load(entry.target);
          }
        });
      },
      // Start a bit before the image scrolls in (rows scroll sideways, pages down).
      { rootMargin: '300px 600px 300px 600px' }
    );
  }
  return observer;
}

/** Starts watching every not-yet-loaded image inside `root`. */
export function observeImages(root) {
  const images = root.querySelectorAll('img[data-src]');
  if (!images.length) return;
  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(images, load);
    return;
  }
  const io = getObserver();
  Array.prototype.forEach.call(images, (img) => io.observe(img));
}
