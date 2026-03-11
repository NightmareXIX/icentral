import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import {
  getUnreadJobApplicationNotificationsForUser,
  markAllJobApplicationNotificationsReadForUser,
  markJobApplicationNotificationRead,
} from '../utils/jobPortalStorage';

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

function formatDate(value) {
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

function mapAnnouncementToCard(post) {
  const postId = String(post?.id || '').trim();
  return {
    id: `announcement-${post.id}`,
    kind: 'announcement',
    theme: 'announcement',
    icon: 'ANN',
    label: 'Announcement',
    title: post.title || 'New announcement posted',
    message: post.summary || 'A new announcement is available in the feed.',
    createdAt: post.createdAt || null,
    ctaLabel: postId ? 'Open Post' : 'Open Home Feed',
    ctaTo: postId ? `/posts/${encodeURIComponent(postId)}` : '/home',
  };
}

function mapVerificationToCard(item, isModerator) {
  if (isModerator) {
    return {
      id: `verification-${item.id}`,
      kind: 'verification',
      theme: 'pending',
      icon: 'REQ',
      label: 'Verification',
      title: 'New approval request pending',
      message: `${item.applicant?.fullName || 'An alumni'} submitted a verification request.`,
      createdAt: item.createdAt || null,
      ctaLabel: 'Review in Moderation',
      ctaTo: '/moderation',
    };
  }

  const normalizedStatus = String(item.status || '').toLowerCase();
  if (normalizedStatus === 'approved') {
    return {
      id: `verification-${item.id}`,
      kind: 'verification',
      theme: 'approved',
      icon: 'OK',
      label: 'Verification',
      title: 'Application accepted',
      message: item.reviewNote || 'Your alumni verification has been approved.',
      createdAt: item.reviewedAt || item.updatedAt || item.createdAt || null,
      ctaLabel: 'Open Job Portal',
      ctaTo: '/job-portal',
    };
  }

  if (normalizedStatus === 'rejected') {
    return {
      id: `verification-${item.id}`,
      kind: 'verification',
      theme: 'rejected',
      icon: 'NO',
      label: 'Verification',
      title: 'Application rejected',
      message: item.reviewNote || 'Your verification request was rejected. You can apply again.',
      createdAt: item.reviewedAt || item.updatedAt || item.createdAt || null,
      ctaLabel: 'Apply Again',
      ctaTo: '/alumni-verification',
    };
  }

  return {
    id: `verification-${item.id}`,
    kind: 'verification',
    theme: 'pending',
    icon: 'PEN',
    label: 'Verification',
    title: 'Application pending',
    message: 'Your alumni verification request is still pending review.',
    createdAt: item.createdAt || null,
    ctaLabel: 'View Verification',
    ctaTo: '/alumni-verification',
  };
}

function mapJobApplicationNotificationToCard(notification) {
  const postId = String(notification?.postId || '').trim();
  const jobTitle = notification.jobTitle || 'your job post';
  const companyName = notification.companyName ? ` at ${notification.companyName}` : '';
  const applicantName = notification.applicantName || 'A student';

  return {
    id: String(notification.id),
    source: 'job-service',
    kind: 'job-application',
    theme: 'pending',
    icon: 'JOB',
    label: 'Job Application',
    title: 'New job application received',
    message: `${applicantName} applied for ${jobTitle}${companyName}.`,
    createdAt: notification.createdAt || null,
    ctaLabel: postId ? 'Open Post' : 'Open Job Portal',
    ctaTo: postId ? `/posts/${encodeURIComponent(postId)}` : '/job-portal',
  };
}

function mapCollabNotificationToCard(notification) {
  const postId = String(notification?.postId || '').trim();
  const postTitle = notification?.postTitle || 'collaboration post';
  const actorName = notification?.actorName || 'A collaborator';
  const eventType = String(notification?.eventType || '').toLowerCase();

  if (eventType === 'join_request_received') {
    return {
      id: String(notification.id),
      kind: 'collab',
      theme: 'pending',
      icon: 'CLB',
      label: 'Collaboration',
      title: 'New join request received',
      message: `${actorName} requested to join "${postTitle}".`,
      createdAt: notification.createdAt || null,
      ctaLabel: postId ? 'Review in Collab' : 'Open Collab',
      ctaTo: postId ? `/collaborate/${encodeURIComponent(postId)}` : '/collaborate',
    };
  }

  if (eventType === 'join_request_accepted') {
    return {
      id: String(notification.id),
      kind: 'collab',
      theme: 'approved',
      icon: 'CLB',
      label: 'Collaboration',
      title: 'Join request accepted',
      message: `Your request for "${postTitle}" was accepted by ${actorName}.`,
      createdAt: notification.createdAt || null,
      ctaLabel: postId ? 'Open Collab' : 'Open Collaborate',
      ctaTo: postId ? `/collaborate/${encodeURIComponent(postId)}` : '/collaborate',
    };
  }

  return {
    id: String(notification.id),
    kind: 'collab',
    theme: 'rejected',
    icon: 'CLB',
    label: 'Collaboration',
    title: 'Join request updated',
    message: `Your request for "${postTitle}" was not accepted.`,
    createdAt: notification.createdAt || null,
    ctaLabel: postId ? 'Open Collab' : 'Open Collaborate',
    ctaTo: postId ? `/collaborate/${encodeURIComponent(postId)}` : '/collaborate',
  };
}

function mapEventNotificationToCard(notification) {
  const postId = String(notification?.postId || '').trim();
  const postTitle = notification?.postTitle || 'event post';
  const volunteerName = notification?.actorName || 'A volunteer';

  return {
    id: String(notification.id),
    kind: 'event',
    theme: 'pending',
    icon: 'EVT',
    label: 'Event Volunteer',
    title: 'New volunteer enrollment received',
    message: `${volunteerName} enrolled to volunteer for "${postTitle}".`,
    createdAt: notification.createdAt || null,
    ctaLabel: postId ? 'Open Event Post' : 'Open Events',
    ctaTo: postId ? `/posts/${encodeURIComponent(postId)}` : '/events',
  };
}

function mapNewsletterNotificationToCard(notification) {
  return {
    id: String(notification?.id || ''),
    kind: 'newsletter',
    theme: 'announcement',
    icon: 'NWS',
    label: 'Newsletter',
    title: notification?.title || 'Monthly newsletter published',
    message: notification?.message || 'A new monthly academic digest is available.',
    createdAt: notification?.createdAt || null,
    ctaLabel: 'Open Home Feed',
    ctaTo: '/home',
  };
}

export default function NotificationsPage() {
  const { isAuthenticated, role, user } = useAuth();
  const normalizedRole = String(role || '').toLowerCase();
  const isModerator = normalizedRole === 'admin' || normalizedRole === 'faculty';
  const isAlumni = normalizedRole === 'alumni';
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [markingRead, setMarkingRead] = useState(false);
  const [busyCardId, setBusyCardId] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [banner, setBanner] = useState({ type: 'idle', message: '' });

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;

    async function loadNotifications() {
      setLoading(true);
      setBanner({ type: 'idle', message: '' });

      const allCards = [];
      const errors = [];
      let lastSeenAt = null;
      let readKeys = [];

      if (isAuthenticated) {
        try {
          const stateResult = await apiRequest('/users/notifications/state', { signal: controller.signal });
          lastSeenAt = stateResult?.data?.lastSeenAt || null;
          readKeys = Array.isArray(stateResult?.data?.readKeys)
            ? stateResult.data.readKeys.map((value) => String(value))
            : [];
        } catch (error) {
          if (error.name !== 'AbortError') {
            errors.push(`Read state: ${error.message}`);
          }
        }
      }

      const announcementQuery = '/posts/feed?type=ANNOUNCEMENT&status=published&limit=12&offset=0';
      try {
        const announcementsResult = await apiRequest(announcementQuery, { signal: controller.signal });
        const announcements = Array.isArray(announcementsResult.data) ? announcementsResult.data : [];
        allCards.push(...announcements.map(mapAnnouncementToCard));
      } catch (error) {
        if (error.name !== 'AbortError') {
          errors.push(`Announcements: ${error.message}`);
        }
      }

      if (isAuthenticated && (isModerator || isAlumni)) {
        try {
          const statusParam = isModerator ? 'pending' : 'all';
          const verificationResult = await apiRequest(`/users/notifications/alumni-verifications?status=${statusParam}&limit=20`, {
            signal: controller.signal,
          });
          const items = Array.isArray(verificationResult.data) ? verificationResult.data : [];
          allCards.push(...items.map((item) => mapVerificationToCard(item, isModerator)));
        } catch (error) {
          if (error.name !== 'AbortError') {
            errors.push(`Verification: ${error.message}`);
          }
        }
      }

      if (isAuthenticated && user?.id) {
        try {
          const jobNotifications = await getUnreadJobApplicationNotificationsForUser(user.id, { signal: controller.signal });
          allCards.push(...jobNotifications.map(mapJobApplicationNotificationToCard));
        } catch (error) {
          if (error.name !== 'AbortError') {
            errors.push(`Job applications: ${error.message}`);
          }
        }
      }

      if (isAuthenticated) {
        try {
          const collabResult = await apiRequest('/posts/collab-notifications?limit=30', {
            signal: controller.signal,
          });
          const collabNotifications = Array.isArray(collabResult?.data) ? collabResult.data : [];
          allCards.push(...collabNotifications.map(mapCollabNotificationToCard));
        } catch (error) {
          if (error.name !== 'AbortError') {
            errors.push(`Collaboration: ${error.message}`);
          }
        }
      }

      if (isAuthenticated) {
        try {
          const eventResult = await apiRequest('/posts/event-notifications?limit=30', {
            signal: controller.signal,
          });
          const eventNotifications = Array.isArray(eventResult?.data) ? eventResult.data : [];
          allCards.push(...eventNotifications.map(mapEventNotificationToCard));
        } catch (error) {
          if (error.name !== 'AbortError') {
            errors.push(`Events: ${error.message}`);
          }
        }
      }

      if (isAuthenticated) {
        try {
          const newsletterResult = await apiRequest('/posts/newsletter/notifications?limit=30', {
            signal: controller.signal,
          });
          const newsletterNotifications = Array.isArray(newsletterResult?.data) ? newsletterResult.data : [];
          allCards.push(...newsletterNotifications.map(mapNewsletterNotificationToCard));
        } catch (error) {
          if (error.name !== 'AbortError') {
            errors.push(`Newsletter: ${error.message}`);
          }
        }
      }

      if (!isMounted) return;

      const sorted = allCards
        .slice()
        .sort((a, b) => {
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bTime - aTime;
        });

      const unreadOnly = (() => {
        const readKeySet = new Set(readKeys);
        const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;

        return sorted.filter((card) => {
          if (card.source === 'job-service') return true;
          if (readKeySet.has(String(card.id))) return false;
          if (!card.createdAt) return true;
          const createdAtMs = new Date(card.createdAt).getTime();
          if (Number.isNaN(createdAtMs)) return true;
          if (Number.isNaN(lastSeenMs)) return true;
          return createdAtMs > lastSeenMs;
        });
      })();

      setCards(unreadOnly);
      if (errors.length) {
        setBanner({ type: 'error', message: `Some notifications failed to load. ${errors.join(' | ')}` });
      }
      setLoading(false);
    }

    loadNotifications();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [isAuthenticated, isModerator, isAlumni, user?.id, refreshTick]);

  const headerCopy = useMemo(() => {
    if (isModerator) {
      return {
        eyebrow: 'Notifications',
        title: 'Admin Notification Center',
        subtitle: 'You will see moderation, collaboration, and feed updates here.',
      };
    }
    if (isAlumni) {
      return {
        eyebrow: 'Notifications',
        title: 'Alumni Notification Center',
        subtitle: 'You will see collaboration updates, verification outcomes, and feed activity here.',
      };
    }
    return {
      eyebrow: 'Notifications',
      title: 'Notification Center',
      subtitle: 'Announcements, collaboration updates, and account-relevant activity appear here.',
    };
  }, [isAlumni, isModerator]);

  async function markAllAsRead() {
    if (!isAuthenticated || cards.length === 0) return;

    const localCards = cards.filter((card) => card.source === 'job-service');
    const apiCards = cards.filter((card) => card.source !== 'job-service');

    setMarkingRead(true);
    try {
      if (localCards.length > 0 && user?.id) {
        await markAllJobApplicationNotificationsReadForUser(user.id);
      }

      if (apiCards.length > 0) {
        const latestCardTime = apiCards
          .map((card) => (card.createdAt ? new Date(card.createdAt).getTime() : 0))
          .filter((value) => Number.isFinite(value) && value > 0)
          .sort((a, b) => b - a)[0];

        const payload = latestCardTime
          ? { lastSeenAt: new Date(latestCardTime).toISOString() }
          : {};

        await apiRequest('/users/notifications/state/mark-read', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      setBanner({ type: 'success', message: 'All current notifications marked as read.' });
      setRefreshTick((prev) => prev + 1);
    } catch (error) {
      setBanner({ type: 'error', message: `Could not mark notifications as read: ${error.message}` });
    } finally {
      setMarkingRead(false);
    }
  }

  async function markSingleAsRead(cardId) {
    if (!isAuthenticated || !cardId) return;
    setBusyCardId(cardId);
    try {
      const targetCard = cards.find((card) => card.id === cardId);
      if (targetCard?.source === 'job-service') {
        await markJobApplicationNotificationRead(cardId);
        setCards((prev) => prev.filter((card) => card.id !== cardId));
        return;
      }

      await apiRequest('/users/notifications/state/mark-read', {
        method: 'POST',
        body: JSON.stringify({ notificationKey: cardId }),
      });
      setCards((prev) => prev.filter((card) => card.id !== cardId));
    } catch (error) {
      setBanner({ type: 'error', message: `Could not mark notification as read: ${error.message}` });
    } finally {
      setBusyCardId('');
    }
  }

  return (
    <div className="moderation-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      <section className="panel placeholder-panel">
        <div className="placeholder-hero">
          <p className="eyebrow">{headerCopy.eyebrow}</p>
          <h2>{headerCopy.title}</h2>
          <p>{headerCopy.subtitle}</p>
        </div>
      </section>

      {!isAuthenticated && (
        <section className="panel">
          <div className="inline-alert warn-alert">
            <p>
              You are in guest mode. <Link to="/login">Sign in</Link> to receive personal account notifications.
            </p>
          </div>
        </section>
      )}

      <section className="panel feed-panel">
        <div className="panel-header feed-header">
          <div>
            <p className="eyebrow">Feed</p>
            <h3>Recent Notifications</h3>
          </div>
          <div className="header-actions">
            <span className="pill">{loading ? 'Loading...' : `${cards.length} unread`}</span>
            {isAuthenticated && (
              <button
                className="btn btn-accent"
                type="button"
                onClick={markAllAsRead}
                disabled={markingRead || cards.length === 0 || loading}
              >
                {markingRead ? 'Marking...' : 'Mark All Read'}
              </button>
            )}
            <button className="btn btn-soft" type="button" onClick={() => setRefreshTick((prev) => prev + 1)}>
              Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div className="skeleton-grid" aria-hidden="true">
            {Array.from({ length: 5 }).map((_, index) => (
              <div className="feed-card skeleton-card" key={index} />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <div className="empty-state">
            <h4>No unread notifications</h4>
            <p>When new updates arrive, unread cards will appear here.</p>
          </div>
        ) : (
          <div className="feed-grid">
            {cards.map((card, index) => (
              <article
                className={`feed-card notification-card is-${card.theme || 'neutral'}`}
                key={card.id}
                style={{ '--card-index': index }}
              >
                <div className="notification-card-head">
                  <div className="notification-identity">
                    <span className="notification-icon" aria-hidden="true">{card.icon || '🔔'}</span>
                    <div className="notification-title-wrap">
                      <p className="notification-kicker">{card.label}</p>
                      <h4 className="notification-title">{card.title}</h4>
                    </div>
                  </div>
                  <span className="notification-time">{formatDate(card.createdAt)}</span>
                </div>

                <p className="notification-message">{card.message}</p>

                <div className="notification-card-footer">
                  <div className="notification-action-row">
                    <Link className="btn btn-soft" to={card.ctaTo}>{card.ctaLabel}</Link>
                    {isAuthenticated && (
                      <button
                        className="btn btn-accent"
                        type="button"
                        onClick={() => markSingleAsRead(card.id)}
                        disabled={busyCardId === card.id}
                      >
                        {busyCardId === card.id ? 'Marking...' : 'Mark as Read'}
                      </button>
                    )}
                  </div>
                  {isAuthenticated && (
                    <span className="notification-read-hint">Unread</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
