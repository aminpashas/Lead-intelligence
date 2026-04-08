/**
 * Lead Intelligence - Embeddable Qualification Form Widget
 *
 * Embeds the multi-step dental implant qualification form as an iframe.
 *
 * Usage:
 * <script src="https://your-domain.com/qualify-widget.js"
 *   data-org="YOUR_ORG_ID"
 *   data-height="700"
 *   data-style="inline"
 * ></script>
 *
 * Options:
 *   data-org       - (required) Organization ID
 *   data-height    - iframe height in px (default: 700)
 *   data-style     - "inline" (default) or "popup"
 *   data-source    - source_type override (default: "landing_page")
 */
(function() {
  'use strict';

  var script = document.currentScript;
  var orgId = script.getAttribute('data-org');
  var height = script.getAttribute('data-height') || '700';
  var style = script.getAttribute('data-style') || 'inline';
  var source = script.getAttribute('data-source') || 'landing_page';

  if (!orgId) {
    console.error('Lead Intelligence Qualify Widget: data-org is required');
    return;
  }

  var baseUrl = script.src.replace('/qualify-widget.js', '');

  // Build URL with UTM params from parent page
  var params = new URLSearchParams(window.location.search);
  var qualifyUrl = baseUrl + '/qualify/' + orgId + '?source_type=' + source;
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'].forEach(function(p) {
    var val = params.get(p);
    if (val) qualifyUrl += '&' + p + '=' + encodeURIComponent(val);
  });

  if (style === 'inline') {
    // Inline iframe
    var container = document.createElement('div');
    container.style.cssText = 'width:100%;max-width:560px;margin:0 auto;';

    var iframe = document.createElement('iframe');
    iframe.src = qualifyUrl;
    iframe.style.cssText = 'width:100%;height:' + height + 'px;border:none;border-radius:16px;overflow:hidden;';
    iframe.setAttribute('title', 'Smile Assessment');
    iframe.setAttribute('loading', 'lazy');

    container.appendChild(iframe);
    script.parentNode.insertBefore(container, script.nextSibling);
  } else {
    // Popup button + modal
    var btn = document.createElement('button');
    btn.textContent = 'Get Your Free Smile Assessment';
    btn.style.cssText = 'background:#2563eb;color:#fff;border:none;padding:14px 28px;font-size:16px;font-weight:600;border-radius:12px;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 4px 14px rgba(37,99,235,0.3);transition:transform 0.15s,box-shadow 0.15s;';
    btn.onmouseover = function() { btn.style.transform = 'translateY(-1px)'; btn.style.boxShadow = '0 6px 20px rgba(37,99,235,0.4)'; };
    btn.onmouseout = function() { btn.style.transform = 'translateY(0)'; btn.style.boxShadow = '0 4px 14px rgba(37,99,235,0.3)'; };

    btn.onclick = function() {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99998;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px);';
      overlay.onclick = function(e) { if (e.target === overlay) document.body.removeChild(overlay); };

      var modal = document.createElement('div');
      modal.style.cssText = 'background:#fff;border-radius:20px;width:100%;max-width:540px;max-height:90vh;overflow:hidden;position:relative;box-shadow:0 25px 50px rgba(0,0,0,0.15);';

      var close = document.createElement('button');
      close.innerHTML = '&times;';
      close.style.cssText = 'position:absolute;top:12px;right:16px;background:none;border:none;font-size:28px;color:#999;cursor:pointer;z-index:2;line-height:1;';
      close.onclick = function() { document.body.removeChild(overlay); };

      var frame = document.createElement('iframe');
      frame.src = qualifyUrl;
      frame.style.cssText = 'width:100%;height:' + height + 'px;border:none;';
      frame.setAttribute('title', 'Smile Assessment');

      modal.appendChild(close);
      modal.appendChild(frame);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    };

    script.parentNode.insertBefore(btn, script.nextSibling);
  }
})();
