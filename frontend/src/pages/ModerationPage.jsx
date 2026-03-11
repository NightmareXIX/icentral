import { startTransition, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

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
  if (!value) return 'Not sent';
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

export default function ModerationPage() {
  const { isAuthenticated, isModerator } = useAuth();
  const [tags, setTags] = useState([]);
  const [verificationItems, setVerificationItems] = useState([]);
  const [tagName, setTagName] = useState('');
  const [selectedTagId, setSelectedTagId] = useState('');
  const [verificationFilter, setVerificationFilter] = useState('pending');
  const [loadingTags, setLoadingTags] = useState(true);
  const [loadingVerification, setLoadingVerification] = useState(true);
  const [loadingNewsletter, setLoadingNewsletter] = useState(true);
  const [submittingTag, setSubmittingTag] = useState(false);
  const [busyVerificationId, setBusyVerificationId] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [banner, setBanner] = useState({ type: 'idle', message: '' });
  const [newsletterState, setNewsletterState] = useState(null);

  const selectedTagName = (() => {
    if (!selectedTagId) return 'All tags';
    const match = tags.find((tag) => tag.id === selectedTagId || tag.slug === selectedTagId);
    return match ? match.name : selectedTagId;
  })();

  useEffect(() => {
    let isMounted = true;

    async function loadTags() {
      setLoadingTags(true);
      try {
        const result = await apiRequest('/posts/tags');
        if (!isMounted) return;
        startTransition(() => {
          setTags(Array.isArray(result.data) ? result.data : []);
        });
      } catch (error) {
        if (!isMounted) return;
        setBanner({ type: 'error', message: `Failed to load tags: ${error.message}` });
      } finally {
        if (isMounted) setLoadingTags(false);
      }
    }

    loadTags();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    async function loadVerificationRequests() {
      if (!isModerator || !isAuthenticated) {
        setVerificationItems([]);
        setLoadingVerification(false);
        return;
      }

      setLoadingVerification(true);
      try {
        const result = await apiRequest(`/users/notifications/alumni-verifications?status=${verificationFilter}&limit=30`, {
          signal: controller.signal,
        });
        if (!isMounted) return;
        startTransition(() => {
          setVerificationItems(Array.isArray(result.data) ? result.data : []);
        });
      } catch (error) {
        if (!isMounted || error.name === 'AbortError') return;
        setBanner({ type: 'error', message: `Failed to load verification requests: ${error.message}` });
      } finally {
        if (isMounted) setLoadingVerification(false);
      }
    }

    loadVerificationRequests();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [isModerator, isAuthenticated, verificationFilter, refreshTick]);

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

  async function reviewApplication(id, action) {
    if (!isModerator || !id) return;
    setBusyVerificationId(id);
    try {
      const reviewNote = action === 'reject'
        ? window.prompt('Optional rejection note:', '') || ''
        : '';

      await apiRequest(`/users/notifications/alumni-verifications/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action,
          reviewNote: reviewNote.trim() || null,
        }),
      });
      setBanner({
        type: 'success',
        message: `Application ${action === 'approve' ? 'approved' : 'rejected'}.`,
      });
      setRefreshTick((prev) => prev + 1);
    } catch (error) {
      setBanner({ type: 'error', message: `Could not review application: ${error.message}` });
    } finally {
      setBusyVerificationId(null);
    }
  }

  async function handleCreateTag(event) {
    event.preventDefault();
    if (!isAuthenticated || !isModerator) {
      setBanner({ type: 'error', message: 'Only moderators can add tags.' });
      return;
    }

    const name = tagName.trim();
    if (!name) return;

    setSubmittingTag(true);
    try {
      await apiRequest('/posts/tags', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setTagName('');
      setBanner({ type: 'success', message: `Tag "${name}" is ready.` });

      const result = await apiRequest('/posts/tags');
      startTransition(() => {
        setTags(Array.isArray(result.data) ? result.data : []);
      });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not create tag: ${error.message}` });
    } finally {
      setSubmittingTag(false);
    }
  }

  const newsletterDraft = newsletterState?.draft || null;
  const newsletterIssue = newsletterState?.issue || null;
  const newsletterMeta = newsletterState?.meta || null;
  const newsletterSettings = newsletterState?.settings || null;
  const newsletterIssueLabel = newsletterDraft?.issueMonthLabel || newsletterIssue?.issueMonthLabel || 'Current issue';
  const newsletterStatusLabel = loadingNewsletter
    ? 'Loading...'
    : (newsletterIssue?.status ? String(newsletterIssue.status).toUpperCase() : 'DRAFT');
  const newsletterHighlightCount = newsletterDraft?.counts?.total ?? 0;

  return (
    <div className="moderation-page">
      <section className="panel placeholder-panel">
        <div className="placeholder-hero">
          <p className="eyebrow">Moderator Console</p>
          <h2>Moderation</h2>
          <p>Manage publication workflows, taxonomy, and alumni verification from one desk.</p>
        </div>
      </section>

      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      <section className="panel newsletter-route-card">
        <div className="newsletter-route-copy">
          <p className="eyebrow">Newsletter</p>
          <h3>Monthly Academic Digest</h3>
          <p>Open the dedicated workspace to preview highlights, choose recipients, and send the issue.</p>
          <div className="newsletter-outline-row" aria-hidden="true">
            <span>Achievement</span>
            <span>Jobs</span>
            <span>Events</span>
            <span>Collab</span>
          </div>
        </div>

        <div className="newsletter-route-side">
          <div className="newsletter-route-pills">
            <span className="pill">{newsletterIssueLabel}</span>
            <span className="pill">{newsletterStatusLabel}</span>
            <span className="pill">{loadingNewsletter ? '...' : `${newsletterHighlightCount} highlighted`}</span>
            {!loadingNewsletter && newsletterIssue?.lastSentAt && (
              <span className="pill">Last sent {formatDateTime(newsletterIssue.lastSentAt)}</span>
            )}
            {!loadingNewsletter && newsletterSettings && !newsletterSettings.effectiveAutoSendEnabled && (
              <span className="pill tone-muted">Auto-send off</span>
            )}
            {!loadingNewsletter && newsletterMeta && !newsletterMeta.smtpConfigured && (
              <span className="pill tone-warn">SMTP missing</span>
            )}
          </div>

          <Link className="btn btn-accent newsletter-route-button" to="/moderation/newsletter">
            Open newsletter desk
          </Link>
        </div>
      </section>

      <section className="panel tag-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Taxonomy</p>
            <h3>Tags</h3>
          </div>
          <span className="pill pill-ghost">POST /posts/tags</span>
        </div>

        <form className="inline-form" onSubmit={handleCreateTag}>
          <label className="sr-only" htmlFor="new-tag-name">Tag name</label>
          <input
            id="new-tag-name"
            type="text"
            placeholder="Create a tag (e.g. Research)"
            value={tagName}
            onChange={(e) => setTagName(e.target.value)}
            disabled={!isModerator}
          />
          <button className="btn btn-accent" type="submit" disabled={submittingTag || !isModerator}>
            {submittingTag ? 'Adding...' : 'Add Tag'}
          </button>
        </form>

        <div className="tag-list-wrap">
          {loadingTags ? (
            <p className="muted-line">Loading tags...</p>
          ) : tags.length === 0 ? (
            <p className="muted-line">No tags yet. Add one to organize feeds.</p>
          ) : (
            <ul className="tag-cloud" aria-label="Existing tags">
              {tags.map((tag) => (
                <li key={tag.id}>
                  <button
                    type="button"
                    className={`tag-chip ${selectedTagId && (selectedTagId === tag.id || selectedTagId === tag.slug) ? 'is-active' : ''}`}
                    onClick={() => setSelectedTagId(selectedTagId === tag.id ? '' : tag.id)}
                    title={`Select ${tag.name}`}
                  >
                    <span>{tag.name}</span>
                    <small>{tag.slug}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="api-note">
          <p>API Base: <code>{API_BASE_URL}</code></p>
          <p>Selected Tag Filter: <strong>{selectedTagName}</strong></p>
          <p>Role-aware actions: {isModerator ? 'Moderator controls enabled' : 'Standard controls'}</p>
        </div>
      </section>

      <section className="panel feed-panel">
        <div className="panel-header feed-header">
          <div>
            <p className="eyebrow">Verification Queue</p>
            <h3>Alumni Verification Requests</h3>
          </div>
          <div className="header-actions">
            <span className="pill">{loadingVerification ? 'Loading...' : `${verificationItems.length} request(s)`}</span>
            <button className="btn btn-soft" type="button" onClick={() => setRefreshTick((prev) => prev + 1)}>
              Refresh
            </button>
          </div>
        </div>

        <form className="feed-filters" onSubmit={(event) => event.preventDefault()}>
          <label>
            <span>Status</span>
            <select value={verificationFilter} onChange={(event) => setVerificationFilter(event.target.value)}>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="all">All</option>
            </select>
          </label>
        </form>

        {loadingVerification ? (
          <div className="skeleton-grid" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, index) => (
              <div className="feed-card skeleton-card" key={index} />
            ))}
          </div>
        ) : verificationItems.length === 0 ? (
          <div className="empty-state">
            <h4>No verification applications</h4>
            <p>No applications match the current status filter.</p>
          </div>
        ) : (
          <div className="feed-grid">
            {verificationItems.map((item, index) => (
              <article className="feed-card social-post-card" key={item.id} style={{ '--card-index': index }}>
                <div className="social-post-header">
                  <div className="post-author-chip">
                    <span className="post-avatar">A</span>
                    <div>
                      <strong>{item.applicant?.fullName || 'Unknown applicant'}</strong>
                      <small>{item.applicant?.email || 'No email available'}</small>
                    </div>
                  </div>
                  <div className="pill-row">
                    <span className="pill">{String(item.status || 'pending').toUpperCase()}</span>
                  </div>
                </div>

                <div className="api-note">
                  <p><strong>Student ID:</strong> {item.studentId || 'N/A'}</p>
                  <p><strong>Current Job Info:</strong> {item.currentJobInfo || 'N/A'}</p>
                  <p><strong>Submitted:</strong> {item.createdAt ? new Date(item.createdAt).toLocaleString() : 'N/A'}</p>
                  {item.reviewNote && <p><strong>Review Note:</strong> {item.reviewNote}</p>}
                </div>

                {item.idCardImageDataUrl && (
                  <div className="feed-image-wrap">
                    <img src={item.idCardImageDataUrl} alt={`ID card of ${item.applicant?.fullName || 'applicant'}`} loading="lazy" />
                  </div>
                )}

                <div className="feed-card-actions social-actions">
                  <button
                    className="btn btn-accent"
                    type="button"
                    disabled={busyVerificationId === item.id || item.status !== 'pending'}
                    onClick={() => reviewApplication(item.id, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn-danger-soft"
                    type="button"
                    disabled={busyVerificationId === item.id || item.status !== 'pending'}
                    onClick={() => reviewApplication(item.id, 'reject')}
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
