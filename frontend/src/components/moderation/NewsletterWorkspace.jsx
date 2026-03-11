import { startTransition, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/useAuth';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

async function apiRequest(path, options = {}) {
  const storedToken = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(storedToken ? { Authorization: `Bearer ${storedToken}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof data === 'string'
      ? data
      : data?.error || data?.message || 'Request failed';
    throw new Error(message);
  }

  return data;
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function truncateText(value, maxLength = 140) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function buildNewsletterPreviewMeta(sectionKey, item) {
  if (!item || typeof item !== 'object') return '';

  if (sectionKey === 'achievement') {
    return [item.authorName, Number.isFinite(Number(item.upvoteCount)) ? `${item.upvoteCount} upvotes` : '']
      .filter(Boolean)
      .join(' | ');
  }

  if (sectionKey === 'jobs') {
    return [item.companyName, item.deadline ? `Deadline ${formatDateTime(item.deadline)}` : '']
      .filter(Boolean)
      .join(' | ');
  }

  if (sectionKey === 'events') {
    return [item.location, item.startsAt ? `Event date ${formatDateTime(item.startsAt)}` : '']
      .filter(Boolean)
      .join(' | ');
  }

  if (sectionKey === 'collabs') {
    return [item.category, item.creatorName, item.deadline ? `Deadline ${formatDateTime(item.deadline)}` : '']
      .filter(Boolean)
      .join(' | ');
  }

  return '';
}

const NEWSLETTER_SECTIONS = [
  { key: 'achievement', label: 'Achievement of the Month', accent: 'ACH' },
  { key: 'jobs', label: 'Job Opportunities', accent: 'JOB' },
  { key: 'events', label: 'Event Highlights', accent: 'EVT' },
  { key: 'collabs', label: 'Collaboration Opportunities', accent: 'COL' },
];

function buildSectionPreview(section) {
  if (!Array.isArray(section.items) || section.items.length === 0) {
    return 'No published posts selected';
  }

  if (section.items.length === 1) {
    return section.items[0]?.title || 'Selected post';
  }

  const firstTitle = section.items[0]?.title || 'Selected post';
  return `${firstTitle} + ${section.items.length - 1} more`;
}

export default function NewsletterWorkspace() {
  const { isAuthenticated, isModerator } = useAuth();
  const [loadingNewsletter, setLoadingNewsletter] = useState(true);
  const [newsletterState, setNewsletterState] = useState(null);
  const [sendingNewsletter, setSendingNewsletter] = useState(false);
  const [updatingAutoSend, setUpdatingAutoSend] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [banner, setBanner] = useState({ type: 'idle', message: '' });
  const [recipientsModalOpen, setRecipientsModalOpen] = useState(false);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [newsletterRecipients, setNewsletterRecipients] = useState([]);
  const [recipientSummary, setRecipientSummary] = useState(null);
  const [selectedRecipientIds, setSelectedRecipientIds] = useState([]);
  const [recipientSelectionInitialized, setRecipientSelectionInitialized] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState('');

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    async function loadNewsletterState() {
      if (!isModerator || !isAuthenticated) {
        setNewsletterState(null);
        setLoadingNewsletter(false);
        return;
      }

      setLoadingNewsletter(true);
      try {
        const result = await apiRequest('/posts/newsletter/current', {
          signal: controller.signal,
        });
        if (!isMounted) return;
        startTransition(() => {
          setNewsletterState(result?.data || null);
        });
      } catch (error) {
        if (!isMounted || error.name === 'AbortError') return;
        setBanner({ type: 'error', message: `Failed to load newsletter status: ${error.message}` });
      } finally {
        if (isMounted) setLoadingNewsletter(false);
      }
    }

    loadNewsletterState();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [isModerator, isAuthenticated, refreshTick]);

  useEffect(() => {
    if (!recipientsModalOpen) return undefined;

    function handleEscape(event) {
      if (event.key !== 'Escape' || loadingRecipients || sendingNewsletter) return;
      setRecipientsModalOpen(false);
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [recipientsModalOpen, loadingRecipients, sendingNewsletter]);

  async function loadNewsletterRecipients() {
    setLoadingRecipients(true);
    try {
      const previousSelectedIds = new Set(selectedRecipientIds);
      const result = await apiRequest('/posts/newsletter/recipients');
      const recipients = Array.isArray(result?.data) ? result.data : [];
      const summary = result?.summary || null;
      const allRecipientIds = recipients
        .map((item) => String(item?.id || '').trim())
        .filter(Boolean);
      const nextSelectedIds = recipientSelectionInitialized
        ? allRecipientIds.filter((id) => previousSelectedIds.has(id))
        : allRecipientIds;

      startTransition(() => {
        setNewsletterRecipients(recipients);
        setRecipientSummary(summary);
        setSelectedRecipientIds(nextSelectedIds);
        setRecipientSelectionInitialized(true);
      });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not load recipients: ${error.message}` });
    } finally {
      setLoadingRecipients(false);
    }
  }

  async function handleOpenRecipients() {
    if (!isAuthenticated || !isModerator) {
      setBanner({ type: 'error', message: 'Only moderators can manage newsletter recipients.' });
      return;
    }

    setRecipientsModalOpen(true);
    await loadNewsletterRecipients();
  }

  function toggleRecipientSelection(recipientId) {
    setSelectedRecipientIds((prev) => (
      prev.includes(recipientId)
        ? prev.filter((id) => id !== recipientId)
        : [...prev, recipientId]
    ));
  }

  async function handleToggleAutoSend(nextValue) {
    if (!isAuthenticated || !isModerator) {
      setBanner({ type: 'error', message: 'Only moderators can update newsletter settings.' });
      return;
    }

    setUpdatingAutoSend(true);
    try {
      const result = await apiRequest('/posts/newsletter/settings', {
        method: 'PATCH',
        body: JSON.stringify({ autoSendEnabled: nextValue }),
      });
      const updatedSettings = result?.data || null;
      setNewsletterState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          settings: updatedSettings,
          meta: {
            ...(prev.meta || {}),
            autoSendEnabled: updatedSettings?.autoSendEnabled,
            effectiveAutoSendEnabled: updatedSettings?.effectiveAutoSendEnabled,
            scheduleEnabled: updatedSettings?.envEnabled ?? prev.meta?.scheduleEnabled,
          },
        };
      });
      setBanner({
        type: 'success',
        message: `Newsletter auto-send ${nextValue ? 'enabled' : 'disabled'}.`,
      });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not update auto-send: ${error.message}` });
    } finally {
      setUpdatingAutoSend(false);
    }
  }

  async function handleSendNewsletter() {
    if (!isAuthenticated || !isModerator) {
      setBanner({ type: 'error', message: 'Only moderators can send the newsletter.' });
      return;
    }

    if (recipientSelectionInitialized && selectedRecipientIds.length === 0) {
      setBanner({ type: 'error', message: 'Select at least one recipient before sending.' });
      return;
    }

    const payload = recipientSelectionInitialized ? { recipientIds: selectedRecipientIds } : null;

    setSendingNewsletter(true);
    try {
      const result = await apiRequest('/posts/newsletter/send', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      });
      const counts = result?.data?.counts || {};
      setBanner({
        type: 'success',
        message: `Newsletter send completed. Sent ${counts.sent ?? 0} of ${counts.attempted ?? 0} attempted emails.`,
      });
      setRefreshTick((prev) => prev + 1);
    } catch (error) {
      setBanner({ type: 'error', message: `Could not send newsletter: ${error.message}` });
    } finally {
      setSendingNewsletter(false);
    }
  }

  const newsletterDraft = newsletterState?.draft || null;
  const newsletterIssue = newsletterState?.issue || null;
  const newsletterMeta = newsletterState?.meta || null;
  const newsletterSettings = newsletterState?.settings || null;
  const selectedRecipientIdSet = useMemo(() => new Set(selectedRecipientIds), [selectedRecipientIds]);
  const newsletterPreviewSections = useMemo(() => NEWSLETTER_SECTIONS.map((section) => ({
    ...section,
    items: Array.isArray(newsletterDraft?.sections?.[section.key]) ? newsletterDraft.sections[section.key] : [],
  })), [newsletterDraft]);
  const filteredRecipients = useMemo(() => newsletterRecipients.filter((recipient) => {
    const normalizedSearch = recipientSearch.trim().toLowerCase();
    if (!normalizedSearch) return true;

    const searchTarget = `${recipient?.fullName || ''} ${recipient?.email || ''}`.toLowerCase();
    return searchTarget.includes(normalizedSearch);
  }), [newsletterRecipients, recipientSearch]);
  const canSendNewsletter = Boolean(
    isAuthenticated
    && isModerator
    && newsletterMeta?.smtpConfigured
    && !loadingNewsletter
    && !sendingNewsletter
    && (!recipientSelectionInitialized || selectedRecipientIds.length > 0)
  );
  const highlightedCount = newsletterDraft?.counts?.total ?? 0;
  const issueMonthLabel = newsletterDraft?.issueMonthLabel || newsletterIssue?.issueMonthLabel || 'Current issue';
  const sendSelectionLabel = recipientSelectionInitialized
    ? `${selectedRecipientIds.length} selected`
    : 'All valid recipients';

  return (
    <div className="newsletter-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      {!loadingNewsletter && newsletterMeta && !newsletterMeta.smtpConfigured && (
        <section className="banner banner-error" aria-live="polite">
          <p>SMTP is not configured for newsletter sending in the post service.</p>
        </section>
      )}

      <section className="panel newsletter-hero-panel">
        <div className="newsletter-hero-copy">
          <p className="eyebrow">Newsletter Desk</p>
          <h2>Monthly Academic Digest</h2>
          <p>Curate the current issue from published community highlights, then deliver it to the selected audience.</p>
          <div className="newsletter-outline-row" aria-hidden="true">
            <span>Achievement</span>
            <span>Jobs</span>
            <span>Events</span>
            <span>Collab</span>
          </div>
        </div>

        <div className="newsletter-hero-stats">
          <article className="newsletter-stat-card">
            <span>Issue</span>
            <strong>{issueMonthLabel}</strong>
          </article>
          <article className="newsletter-stat-card">
            <span>Status</span>
            <strong>{loadingNewsletter ? 'Loading...' : (newsletterIssue?.status || 'Draft')}</strong>
          </article>
          <article className="newsletter-stat-card">
            <span>Highlights</span>
            <strong>{highlightedCount}</strong>
          </article>
          <article className="newsletter-stat-card">
            <span>Selection</span>
            <strong>{sendSelectionLabel}</strong>
          </article>
        </div>
      </section>

      <section className="panel newsletter-workspace-panel">
        <div className="newsletter-toolbar">
          <div className="newsletter-toolbar-primary">
            <span className="pill">{issueMonthLabel}</span>
            <span className="pill">{loadingNewsletter ? 'Loading...' : `${highlightedCount} highlighted`}</span>
            {!loadingNewsletter && newsletterIssue?.lastSentAt && (
              <span className="pill">Last sent {formatDateTime(newsletterIssue.lastSentAt)}</span>
            )}
            {!loadingNewsletter && newsletterSettings && !newsletterSettings.envEnabled && (
              <span className="pill tone-muted">Env Off</span>
            )}
          </div>

          <div className="newsletter-toolbar-actions">
            <label className={`newsletter-toggle${updatingAutoSend ? ' is-busy' : ''}`}>
              <input
                type="checkbox"
                checked={Boolean(newsletterSettings?.autoSendEnabled)}
                disabled={loadingNewsletter || updatingAutoSend || !isModerator}
                onChange={(event) => handleToggleAutoSend(event.target.checked)}
              />
              <span className="newsletter-toggle-copy">Auto-send</span>
              <span className="newsletter-toggle-track" aria-hidden="true">
                <span className="newsletter-toggle-thumb" />
              </span>
            </label>

            <button className="btn btn-soft" type="button" onClick={handleOpenRecipients} disabled={loadingNewsletter || loadingRecipients}>
              {recipientSelectionInitialized ? `Recipients (${selectedRecipientIds.length})` : 'Recipients'}
            </button>
            <button
              className="btn btn-accent"
              type="button"
              onClick={handleSendNewsletter}
              disabled={!canSendNewsletter}
            >
              {sendingNewsletter ? 'Sending...' : 'Send now'}
            </button>
            <button className="btn btn-soft" type="button" onClick={() => setRefreshTick((prev) => prev + 1)}>
              Refresh
            </button>
          </div>
        </div>

        {loadingNewsletter ? (
          <div className="newsletter-preview-grid">
            {NEWSLETTER_SECTIONS.map((section) => (
              <div className="newsletter-section-card newsletter-section-card-loading" key={section.key}>
                <div className="newsletter-loading-line wide" />
                <div className="newsletter-loading-line" />
              </div>
            ))}
          </div>
        ) : (
          <div className="newsletter-preview-grid">
            {newsletterPreviewSections.map((section) => (
              <details className="newsletter-section-card" key={section.key}>
                <summary className="newsletter-section-summary">
                  <div className="newsletter-section-summary-copy">
                    <span className="newsletter-section-accent">{section.accent}</span>
                    <h3>{section.label}</h3>
                    <p>{buildSectionPreview(section)}</p>
                  </div>

                  <div className="newsletter-section-summary-side">
                    <span className="pill">{section.items.length}</span>
                    <span className="newsletter-section-chevron" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M8.3 10.3a1 1 0 0 1 1.4 0L12 12.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-3 3a1 1 0 0 1-1.4 0l-3-3a1 1 0 0 1 0-1.4z" />
                      </svg>
                    </span>
                  </div>
                </summary>

                <div className="newsletter-section-items">
                  {section.items.length === 0 ? (
                    <p className="newsletter-section-empty">No published posts selected.</p>
                  ) : (
                    section.items.map((item) => {
                      const meta = buildNewsletterPreviewMeta(section.key, item);
                      return (
                        <article className="newsletter-section-item" key={item.id || `${section.key}-${item.title}`}>
                          <div className="newsletter-section-item-head">
                            <strong>{item.title || 'Untitled item'}</strong>
                            {meta && <span>{meta}</span>}
                          </div>
                          {item.summary && <p>{truncateText(item.summary)}</p>}
                        </article>
                      );
                    })
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>

      {recipientsModalOpen && (
        <div
          className="profile-edit-backdrop newsletter-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Newsletter recipients"
          onClick={() => {
            if (loadingRecipients || sendingNewsletter) return;
            setRecipientsModalOpen(false);
          }}
        >
          <section className="panel profile-edit-modal newsletter-recipient-modal" onClick={(event) => event.stopPropagation()}>
            <div className="newsletter-modal-head">
              <div>
                <p className="eyebrow">Recipients</p>
                <h3>Audience Selection</h3>
              </div>
              <button className="btn btn-soft" type="button" onClick={() => setRecipientsModalOpen(false)} disabled={loadingRecipients || sendingNewsletter}>
                Done
              </button>
            </div>

            <div className="newsletter-modal-stats">
              <article className="newsletter-mini-stat">
                <span>Valid</span>
                <strong>{loadingRecipients ? '...' : (recipientSummary?.validEmails ?? newsletterRecipients.length)}</strong>
              </article>
              <article className="newsletter-mini-stat">
                <span>Selected</span>
                <strong>{selectedRecipientIds.length}</strong>
              </article>
              <article className="newsletter-mini-stat">
                <span>Invalid</span>
                <strong>{recipientSummary?.skippedInvalidEmails ?? 0}</strong>
              </article>
              <article className="newsletter-mini-stat">
                <span>Duplicate</span>
                <strong>{recipientSummary?.skippedDuplicateEmails ?? 0}</strong>
              </article>
            </div>

            <div className="newsletter-recipient-toolbar">
              <label className="newsletter-search-field">
                <span className="sr-only">Search recipients</span>
                <span className="newsletter-search-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M10 3a7 7 0 1 1 0 14a7 7 0 0 1 0-14zm0 2a5 5 0 1 0 .001 10.001A5 5 0 0 0 10 5zm8.707 11.293l2 2a1 1 0 0 1-1.414 1.414l-2-2a1 1 0 0 1 1.414-1.414z" />
                  </svg>
                </span>
                <input
                  type="search"
                  value={recipientSearch}
                  onChange={(event) => setRecipientSearch(event.target.value)}
                  placeholder="Search name or email"
                />
              </label>

              <div className="newsletter-recipient-actions">
                <button
                  className="btn btn-soft"
                  type="button"
                  onClick={() => setSelectedRecipientIds(newsletterRecipients.map((recipient) => String(recipient?.id || '').trim()).filter(Boolean))}
                  disabled={loadingRecipients}
                >
                  Select all
                </button>
                <button className="btn btn-soft" type="button" onClick={() => setSelectedRecipientIds([])} disabled={loadingRecipients}>
                  Clear
                </button>
                <button className="btn btn-soft" type="button" onClick={loadNewsletterRecipients} disabled={loadingRecipients}>
                  {loadingRecipients ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>

            {loadingRecipients ? (
              <div className="newsletter-recipient-grid">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div className="newsletter-recipient-card is-loading" key={`recipient-skeleton-${index}`}>
                    <div className="newsletter-recipient-skeleton avatar" />
                    <div className="newsletter-recipient-skeleton text" />
                  </div>
                ))}
              </div>
            ) : filteredRecipients.length === 0 ? (
              <div className="empty-state newsletter-empty-state">
                <h4>No recipients found</h4>
                <p>Adjust the search to continue selecting recipients.</p>
              </div>
            ) : (
              <div className="newsletter-recipient-grid">
                {filteredRecipients.map((recipient, index) => {
                  const recipientId = String(recipient?.id || '').trim();
                  const recipientName = recipient?.fullName || 'Unnamed recipient';
                  const recipientEmail = recipient?.email || 'No email';
                  const checked = selectedRecipientIdSet.has(recipientId);
                  const avatar = String(recipientName || recipientEmail).trim().charAt(0).toUpperCase() || 'R';

                  return (
                    <label className={`newsletter-recipient-card${checked ? ' is-selected' : ''}`} key={recipientId || `recipient-${index}`}>
                      <input
                        className="newsletter-recipient-input"
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRecipientSelection(recipientId)}
                      />
                      <span className="newsletter-recipient-check" aria-hidden="true">
                        <svg viewBox="0 0 20 20" focusable="false">
                          <path d="M7.9 13.3L4.8 10.2l-1.4 1.4 4.5 4.5 8.7-8.7-1.4-1.4z" />
                        </svg>
                      </span>
                      <span className="newsletter-recipient-avatar" aria-hidden="true">{avatar}</span>
                      <span className="newsletter-recipient-copy">
                        <strong>{recipientName}</strong>
                        <small>{recipientEmail}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
