/**
 * Post-render override for Mintlify's auto-generated MCP server references.
 *
 * Mintlify generates a docs-search MCP endpoint at pmxt.dev/docs/mcp.
 * We have a real MCP server at https://api.pmxt.dev/mcp that users should
 * connect to instead. This script rewrites all references after Mintlify
 * renders them (including SPA navigations via MutationObserver).
 */
(function () {
  "use strict";

  var MINTLIFY_MCP_PATTERN = /https?:\/\/pmxt\.dev\/docs\/mcp/g;
  var REAL_MCP_URL = "https://api.pmxt.dev/mcp";
  var REAL_MCP_NPX = "npx -y @pmxt/mcp";

  /**
   * Rewrite a single element's text content and relevant attributes.
   */
  function rewriteElement(el) {
    // Rewrite href, data-clipboard-text, value, and similar attributes
    var attrs = ["href", "data-clipboard-text", "data-value", "value", "data-url"];
    for (var i = 0; i < attrs.length; i++) {
      var attr = attrs[i];
      var val = el.getAttribute(attr);
      if (val && MINTLIFY_MCP_PATTERN.test(val)) {
        MINTLIFY_MCP_PATTERN.lastIndex = 0;
        el.setAttribute(attr, val.replace(MINTLIFY_MCP_PATTERN, REAL_MCP_URL));
      }
      MINTLIFY_MCP_PATTERN.lastIndex = 0;
    }

    // Rewrite visible text that contains the Mintlify MCP URL
    if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
      var text = el.childNodes[0].nodeValue;
      if (MINTLIFY_MCP_PATTERN.test(text)) {
        MINTLIFY_MCP_PATTERN.lastIndex = 0;
        el.childNodes[0].nodeValue = text.replace(MINTLIFY_MCP_PATTERN, REAL_MCP_URL);
      }
      MINTLIFY_MCP_PATTERN.lastIndex = 0;
    }
  }

  /**
   * Rewrite npx commands that reference Mintlify's default MCP package.
   * Mintlify generates commands like: npx @mintlify/mcp@latest ...
   */
  function rewriteNpxCommands(root) {
    var codeEls = root.querySelectorAll("code, pre, [data-clipboard-text]");
    for (var i = 0; i < codeEls.length; i++) {
      var el = codeEls[i];

      // Check clipboard attribute
      var clip = el.getAttribute("data-clipboard-text");
      if (clip && /npx\s+@mintlify\/mcp/.test(clip)) {
        el.setAttribute("data-clipboard-text", clip.replace(/npx\s+@mintlify\/mcp\S*/g, REAL_MCP_NPX));
      }

      // Check visible text
      if (el.textContent && /npx\s+@mintlify\/mcp/.test(el.textContent)) {
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        var node;
        while ((node = walker.nextNode())) {
          if (/npx\s+@mintlify\/mcp/.test(node.nodeValue)) {
            node.nodeValue = node.nodeValue.replace(/npx\s+@mintlify\/mcp\S*/g, REAL_MCP_NPX);
          }
        }
      }
    }
  }

  /**
   * Scan the document (or a subtree) for elements referencing the
   * Mintlify MCP URL and rewrite them.
   */
  function patchAll(root) {
    try {
      if (!root || !root.querySelectorAll) {
        root = document;
      }

      // Links and buttons with href
      var links = root.querySelectorAll('a[href*="pmxt.dev/docs/mcp"]');
      for (var i = 0; i < links.length; i++) {
        rewriteElement(links[i]);
      }

      // Clipboard / copy elements
      var clipEls = root.querySelectorAll('[data-clipboard-text*="pmxt.dev/docs/mcp"]');
      for (var j = 0; j < clipEls.length; j++) {
        rewriteElement(clipEls[j]);
      }

      // Contextual menu items (Claude, Cursor, ChatGPT buttons)
      // These may use data-url, data-value, or onclick with the URL
      var dataUrlEls = root.querySelectorAll(
        '[data-url*="pmxt.dev/docs/mcp"], [data-value*="pmxt.dev/docs/mcp"]'
      );
      for (var k = 0; k < dataUrlEls.length; k++) {
        rewriteElement(dataUrlEls[k]);
      }

      // Catch-all: any element whose text contains the Mintlify MCP URL
      var allEls = root.querySelectorAll("button, a, span, code, pre, input, li, div");
      for (var m = 0; m < allEls.length; m++) {
        var el = allEls[m];
        if (
          el.textContent &&
          el.textContent.indexOf("pmxt.dev/docs/mcp") !== -1
        ) {
          rewriteElement(el);
        }
        // Check value attribute on inputs
        if (el.tagName === "INPUT" && el.value && el.value.indexOf("pmxt.dev/docs/mcp") !== -1) {
          el.value = el.value.replace(MINTLIFY_MCP_PATTERN, REAL_MCP_URL);
          MINTLIFY_MCP_PATTERN.lastIndex = 0;
        }
      }

      // Rewrite npx commands referencing Mintlify's MCP package
      rewriteNpxCommands(root);
    } catch (err) {
      // Never break the page if something unexpected happens
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[pmxt] mcp-override error:", err);
      }
    }
  }

  /**
   * Initialize: patch immediately and observe future DOM changes.
   */
  function init() {
    patchAll(document);

    if (typeof MutationObserver !== "undefined") {
      var debounceTimer = null;
      var observer = new MutationObserver(function () {
        // Debounce rapid mutations (SPA route transitions)
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(function () {
          debounceTimer = null;
          patchAll(document);
        }, 150);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }

  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
