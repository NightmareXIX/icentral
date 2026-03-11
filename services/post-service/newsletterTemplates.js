function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderItemMeta(meta = []) {
    const values = Array.isArray(meta)
        ? meta.map((item) => String(item || '').trim()).filter(Boolean)
        : [];

    if (values.length === 0) {
        return '';
    }

    return `<p style="margin:10px 0 0;color:#4b5563;font-size:13px;line-height:1.7;">${values.map(escapeHtml).join(' | ')}</p>`;
}

function renderItemHtml(item = {}) {
    const title = escapeHtml(item.title || 'Untitled update');
    const summary = escapeHtml(item.summary || '');
    const href = String(item.href || '').trim();
    const linkLabel = escapeHtml(item.linkLabel || 'Open in ICentral');

    return `
        <div style="padding:20px 22px;border:1px solid #dbe5f2;border-radius:18px;background:#ffffff;margin-top:14px;box-sizing:border-box;">
            <h4 style="margin:0;color:#16324f;font-size:18px;line-height:1.4;">${title}</h4>
            ${summary ? `<p style="margin:10px 0 0;color:#243b53;font-size:14px;line-height:1.7;">${summary}</p>` : ''}
            ${renderItemMeta(item.meta)}
            ${href ? `<p style="margin:14px 0 0;"><a href="${escapeHtml(href)}" style="color:#0f4c81;font-weight:600;text-decoration:none;">${linkLabel}</a></p>` : ''}
        </div>
    `;
}

function renderSectionHtml(section = {}) {
    const items = Array.isArray(section.items) ? section.items : [];
    const emptyText = escapeHtml(section.emptyText || 'No items available for this section.');
    const body = items.length > 0
        ? items.map(renderItemHtml).join('')
        : `<div style="margin-top:14px;padding:18px 20px;border:1px dashed #c8d7e8;border-radius:16px;background:#ffffff;color:#52606d;font-size:14px;line-height:1.8;box-sizing:border-box;">${emptyText}</div>`;

    return `
        <div style="margin-top:24px;padding:24px;border:1px solid #d7e5f3;border-radius:20px;background:#f7fbff;box-sizing:border-box;">
            <div style="margin:0 0 6px;padding-bottom:10px;border-bottom:2px solid #d7e5f3;">
                <p style="margin:0 0 4px;color:#486581;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;">Monthly Brief</p>
                <h3 style="margin:0;color:#102a43;font-size:22px;line-height:1.3;">${escapeHtml(section.title || 'Section')}</h3>
            </div>
            ${body}
        </div>
    `;
}

function renderItemText(item = {}) {
    const lines = [];
    const title = String(item.title || 'Untitled update').trim();
    const summary = String(item.summary || '').trim();
    const meta = Array.isArray(item.meta)
        ? item.meta.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const href = String(item.href || '').trim();
    const linkLabel = String(item.linkLabel || 'Open in ICentral').trim();

    lines.push(`- ${title}`);
    if (summary) {
        lines.push(`  ${summary}`);
    }
    if (meta.length > 0) {
        lines.push(`  ${meta.join(' | ')}`);
    }
    if (href) {
        lines.push(`  ${linkLabel}: ${href}`);
    }

    return lines.join('\n');
}

function renderSectionText(section = {}) {
    const items = Array.isArray(section.items) ? section.items : [];
    const lines = [String(section.title || 'Section').trim()];

    if (items.length === 0) {
        lines.push(String(section.emptyText || 'No items available for this section.').trim());
        return lines.join('\n');
    }

    lines.push(...items.map(renderItemText));
    return lines.join('\n');
}

function buildNewsletterEmailBodies(payload = {}) {
    const subject = String(payload.subject || 'ICentral Monthly Newsletter').trim();
    const issueMonthLabel = String(payload.issueMonthLabel || '').trim();
    const issueDateLabel = String(payload.issueDateLabel || '').trim();
    const introduction = String(payload.introduction || '').trim();
    const note = String(payload.note || '').trim();
    const sections = Array.isArray(payload.sections) ? payload.sections : [];

    const html = `
<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(subject)}</title>
    </head>
    <body style="margin:0;padding:24px;background:#eef4f9;font-family:Georgia,'Times New Roman',serif;color:#102a43;">
        <div style="max-width:760px;margin:0 auto;background:#fdfefe;border:1px solid #d7e5f3;border-radius:24px;overflow:hidden;box-shadow:0 18px 48px rgba(15,76,129,0.08);">
            <div style="padding:36px 36px 28px;background:linear-gradient(135deg,#0f4c81 0%,#16324f 100%);color:#f8fbff;">
                <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.28em;text-transform:uppercase;">ICentral Academic Digest</p>
                <h1 style="margin:0;font-size:32px;line-height:1.2;">${escapeHtml(issueMonthLabel || 'Monthly Newsletter')}</h1>
                <p style="margin:14px 0 0;font-size:15px;line-height:1.7;max-width:560px;">
                    A concise academic bulletin highlighting top published community posts, opportunities, and event updates.
                </p>
                ${issueDateLabel ? `<p style="margin:18px 0 0;font-size:14px;line-height:1.6;opacity:0.9;">Issue date: ${escapeHtml(issueDateLabel)}</p>` : ''}
            </div>

            <div style="padding:32px 36px 40px;">
                ${introduction ? `<p style="margin:0;color:#243b53;font-size:15px;line-height:1.8;">${escapeHtml(introduction)}</p>` : ''}
                ${note ? `<div style="margin-top:18px;padding:16px 18px;border-left:4px solid #0f4c81;border-radius:14px;background:#edf5fc;color:#16324f;font-size:14px;line-height:1.8;box-sizing:border-box;">${escapeHtml(note)}</div>` : ''}
                ${sections.map(renderSectionHtml).join('')}
            </div>
        </div>
    </body>
</html>
    `.trim();

    const textParts = [
        subject,
        issueMonthLabel ? `Issue Month: ${issueMonthLabel}` : '',
        issueDateLabel ? `Issue Date: ${issueDateLabel}` : '',
        '',
        introduction,
        note ? `Note: ${note}` : '',
        '',
        ...sections.map((section) => `${renderSectionText(section)}\n`),
    ].filter((value, index, values) => {
        if (index === values.length - 1) return String(value || '').trim().length > 0;
        return value !== '';
    });

    return {
        html,
        text: textParts.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    };
}

module.exports = {
    buildNewsletterEmailBodies,
};
