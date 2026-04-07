/**
 * Lead Intelligence - Embeddable Lead Capture Widget
 *
 * Usage: Add this script to any website/landing page:
 * <script src="https://your-domain.com/widget.js" data-org="YOUR_ORG_ID"></script>
 *
 * Options (data attributes):
 *   data-org          - (required) Your organization ID
 *   data-source       - Lead source type (default: "landing_page")
 *   data-theme        - "light" or "dark" (default: "light")
 *   data-position     - "inline", "bottom-right", "bottom-left" (default: "inline")
 *   data-title        - Form title (default: "Get Your Free Consultation")
 *   data-button-text  - Submit button text (default: "Request Free Consultation")
 *   data-success-msg  - Success message
 */
(function() {
  'use strict';

  const script = document.currentScript;
  const orgId = script.getAttribute('data-org');
  const sourceType = script.getAttribute('data-source') || 'landing_page';
  const theme = script.getAttribute('data-theme') || 'light';
  const position = script.getAttribute('data-position') || 'inline';
  const title = script.getAttribute('data-title') || 'Get Your Free Consultation';
  const buttonText = script.getAttribute('data-button-text') || 'Request Free Consultation';
  const successMsg = script.getAttribute('data-success-msg') || "Thank you! We'll be in touch within 24 hours.";

  // Determine API endpoint
  const apiBase = script.src.replace('/widget.js', '');

  if (!orgId) {
    console.error('Lead Intelligence Widget: data-org attribute is required');
    return;
  }

  // Get UTM params from URL
  const urlParams = new URLSearchParams(window.location.search);
  const utmSource = urlParams.get('utm_source') || '';
  const utmMedium = urlParams.get('utm_medium') || '';
  const utmCampaign = urlParams.get('utm_campaign') || '';
  const utmContent = urlParams.get('utm_content') || '';
  const utmTerm = urlParams.get('utm_term') || '';
  const gclid = urlParams.get('gclid') || '';
  const fbclid = urlParams.get('fbclid') || '';

  // Styles
  const isDark = theme === 'dark';
  const colors = {
    bg: isDark ? '#1a1a2e' : '#ffffff',
    text: isDark ? '#e0e0e0' : '#1a1a2e',
    muted: isDark ? '#888' : '#666',
    border: isDark ? '#333' : '#e0e0e0',
    primary: '#2563eb',
    primaryHover: '#1d4ed8',
    success: '#16a34a',
    error: '#dc2626',
    inputBg: isDark ? '#16213e' : '#f8fafc',
  };

  // Create container
  const container = document.createElement('div');
  container.id = 'li-widget';

  if (position === 'inline') {
    script.parentNode.insertBefore(container, script.nextSibling);
  } else {
    document.body.appendChild(container);
    container.style.cssText = `
      position: fixed;
      ${position === 'bottom-right' ? 'right: 20px;' : 'left: 20px;'}
      bottom: 20px;
      z-index: 99999;
    `;
  }

  container.innerHTML = `
    <div id="li-form-wrapper" style="
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 440px;
      background: ${colors.bg};
      border: 1px solid ${colors.border};
      border-radius: 12px;
      padding: 28px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    ">
      <h3 style="margin: 0 0 4px; font-size: 20px; font-weight: 700; color: ${colors.text};">
        ${title}
      </h3>
      <p style="margin: 0 0 20px; font-size: 14px; color: ${colors.muted};">
        Take the first step toward a permanent smile solution
      </p>

      <form id="li-capture-form" style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <input type="text" name="first_name" placeholder="First Name *" required style="
            padding: 10px 14px; border: 1px solid ${colors.border}; border-radius: 8px;
            font-size: 14px; background: ${colors.inputBg}; color: ${colors.text};
            outline: none; transition: border 0.2s;
          " onfocus="this.style.borderColor='${colors.primary}'" onblur="this.style.borderColor='${colors.border}'">
          <input type="text" name="last_name" placeholder="Last Name" style="
            padding: 10px 14px; border: 1px solid ${colors.border}; border-radius: 8px;
            font-size: 14px; background: ${colors.inputBg}; color: ${colors.text};
            outline: none; transition: border 0.2s;
          " onfocus="this.style.borderColor='${colors.primary}'" onblur="this.style.borderColor='${colors.border}'">
        </div>

        <input type="tel" name="phone" placeholder="Phone Number *" required style="
          padding: 10px 14px; border: 1px solid ${colors.border}; border-radius: 8px;
          font-size: 14px; background: ${colors.inputBg}; color: ${colors.text};
          outline: none; transition: border 0.2s;
        " onfocus="this.style.borderColor='${colors.primary}'" onblur="this.style.borderColor='${colors.border}'">

        <input type="email" name="email" placeholder="Email Address" style="
          padding: 10px 14px; border: 1px solid ${colors.border}; border-radius: 8px;
          font-size: 14px; background: ${colors.inputBg}; color: ${colors.text};
          outline: none; transition: border 0.2s;
        " onfocus="this.style.borderColor='${colors.primary}'" onblur="this.style.borderColor='${colors.border}'">

        <select name="dental_condition" style="
          padding: 10px 14px; border: 1px solid ${colors.border}; border-radius: 8px;
          font-size: 14px; background: ${colors.inputBg}; color: ${colors.text};
          outline: none; cursor: pointer;
        ">
          <option value="">What best describes your situation?</option>
          <option value="missing_all_both">Missing All or Most Teeth</option>
          <option value="missing_all_upper">Missing Upper Teeth</option>
          <option value="missing_all_lower">Missing Lower Teeth</option>
          <option value="failing_teeth">Failing / Decaying Teeth</option>
          <option value="denture_problems">Problems with Current Dentures</option>
          <option value="missing_multiple">Missing Several Teeth</option>
          <option value="other">Other / Not Sure</option>
        </select>

        <textarea name="notes" placeholder="Tell us more about your situation (optional)" rows="2" style="
          padding: 10px 14px; border: 1px solid ${colors.border}; border-radius: 8px;
          font-size: 14px; background: ${colors.inputBg}; color: ${colors.text};
          outline: none; resize: vertical; font-family: inherit;
        " onfocus="this.style.borderColor='${colors.primary}'" onblur="this.style.borderColor='${colors.border}'"></textarea>

        <button type="submit" id="li-submit-btn" style="
          padding: 12px 24px; background: ${colors.primary}; color: white;
          border: none; border-radius: 8px; font-size: 15px; font-weight: 600;
          cursor: pointer; transition: background 0.2s;
        " onmouseover="this.style.background='${colors.primaryHover}'" onmouseout="this.style.background='${colors.primary}'">
          ${buttonText}
        </button>

        <p style="text-align: center; font-size: 11px; color: ${colors.muted}; margin: 0;">
          Your information is secure and will never be shared
        </p>
      </form>

      <div id="li-success" style="display: none; text-align: center; padding: 20px 0;">
        <div style="font-size: 48px; margin-bottom: 12px;">✓</div>
        <h4 style="margin: 0 0 8px; color: ${colors.success}; font-size: 18px;">Thank You!</h4>
        <p style="color: ${colors.muted}; font-size: 14px; margin: 0;">${successMsg}</p>
      </div>

      <div id="li-error" style="display: none; color: ${colors.error}; font-size: 13px; text-align: center; margin-top: 8px;"></div>
    </div>
  `;

  // Handle form submission
  const form = document.getElementById('li-capture-form');
  const submitBtn = document.getElementById('li-submit-btn');
  const successDiv = document.getElementById('li-success');
  const errorDiv = document.getElementById('li-error');

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    submitBtn.textContent = 'Submitting...';
    submitBtn.disabled = true;
    errorDiv.style.display = 'none';

    const formData = new FormData(form);
    const payload = {
      first_name: formData.get('first_name'),
      last_name: formData.get('last_name') || undefined,
      phone: formData.get('phone'),
      email: formData.get('email') || undefined,
      dental_condition: formData.get('dental_condition') || undefined,
      notes: formData.get('notes') || undefined,
      source_type: sourceType,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      utm_content: utmContent,
      utm_term: utmTerm,
      gclid: gclid,
      fbclid: fbclid,
      landing_page_url: window.location.href,
    };

    try {
      const res = await fetch(apiBase + '/api/webhooks/form?org=' + orgId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('Submission failed');

      form.style.display = 'none';
      successDiv.style.display = 'block';

      // Track conversion events
      if (typeof gtag === 'function') {
        gtag('event', 'conversion', { send_to: 'lead_form_submit' });
      }
      if (typeof fbq === 'function') {
        fbq('track', 'Lead');
      }
    } catch (err) {
      errorDiv.textContent = 'Something went wrong. Please try again or call us directly.';
      errorDiv.style.display = 'block';
      submitBtn.textContent = buttonText;
      submitBtn.disabled = false;
    }
  });
})();
