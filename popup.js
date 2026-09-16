const DEFAULT_SIZE = 100;

function render(activeSize) {
  document.querySelectorAll(".size-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.size) === activeSize);
  });
}

chrome.storage.local.get("boxScale", ({ boxScale }) => {
  render(boxScale || DEFAULT_SIZE);
});

document.querySelectorAll(".size-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const size = Number(btn.dataset.size);
    chrome.storage.local.set({ boxScale: size }, () => {
      render(size);
    });
  });
});
