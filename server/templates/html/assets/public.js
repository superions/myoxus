(() => {
  for (const button of document.querySelectorAll("[data-myoxus-public-copy]")) {
    button.addEventListener("click", async () => {
      const target = button.closest("pre")?.querySelector("code");
      const text = target?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = button.dataset.copiedLabel;
        setTimeout(() => {
          button.textContent = button.dataset.copyLabel;
        }, 1600);
      } catch {
        button.textContent = button.dataset.failedLabel;
      }
    });
  }

  const input = document.querySelector("[data-pagefind-search]");
  const results = document.querySelector("[data-pagefind-results]");
  if (input && results) {
    let requestId = 0;
    input.addEventListener("input", async () => {
      const query = input.value.trim();
      requestId += 1;
      const currentRequest = requestId;
      if (query.length < 2 || !window.pagefind?.search) {
        results.hidden = true;
        results.replaceChildren();
        return;
      }
      const search = await window.pagefind.search(query);
      if (currentRequest !== requestId) {
        return;
      }
      const fragments = await Promise.all(
        search.results.slice(0, 6).map((result) => result.data()),
      );
      results.replaceChildren(
        ...fragments.map((result) => {
          const anchor = document.createElement("a");
          anchor.href = result.url;
          const title = document.createElement("strong");
          title.textContent = result.meta?.title || result.url;
          const excerpt = document.createElement("span");
          appendPagefindExcerpt(excerpt, result.excerpt || "");
          anchor.append(title, excerpt);
          return anchor;
        }),
      );
      results.hidden = fragments.length === 0;
    });
  }

  function appendPagefindExcerpt(target, excerptHtml) {
    const template = document.createElement("template");
    template.innerHTML = excerptHtml;
    for (const node of template.content.childNodes) {
      appendAllowedExcerptNode(target, node);
    }
  }

  function appendAllowedExcerptNode(target, node) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(node.textContent || ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    if (node.nodeName.toLowerCase() === "mark") {
      const mark = document.createElement("mark");
      mark.textContent = node.textContent || "";
      target.append(mark);
      return;
    }
    target.append(document.createTextNode(node.textContent || ""));
  }
})();
