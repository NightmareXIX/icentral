import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PostResultCard from '../components/posts/PostResultCard';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
const SEARCH_PAGE_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 300;

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

function normalizeQuery(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseNextCursor(result) {
  return typeof result?.nextCursor === 'string' && result.nextCursor.trim()
    ? result.nextCursor.trim()
    : null;
}

export default function SearchPage() {
  const [searchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState({ type: 'idle', message: '' });
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const q = useMemo(() => normalizeQuery(searchParams.get('q') || ''), [searchParams]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(q);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [q]);

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;

    async function loadInitialResults() {
      setError('');
      setLoadingMore(false);

      if (!debouncedQuery) {
        setItems([]);
        setNextCursor(null);
        setLoading(false);
        return;
      }

      if (debouncedQuery.length < 2) {
        setItems([]);
        setNextCursor(null);
        setLoading(false);
        return;
      }

      setLoading(true);

      const params = new URLSearchParams({
        q: debouncedQuery,
        limit: String(SEARCH_PAGE_LIMIT),
      });

      try {
        const result = await apiRequest(`/posts/search?${params.toString()}`, {
          signal: controller.signal,
        });

        if (!isMounted) return;
        setItems(Array.isArray(result?.items) ? result.items : []);
        setNextCursor(parseNextCursor(result));
      } catch (requestError) {
        if (!isMounted || requestError.name === 'AbortError') return;
        setItems([]);
        setNextCursor(null);
        setError(requestError.message || 'Could not search posts.');
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadInitialResults();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [debouncedQuery]);

  async function handleLoadMore() {
    if (!nextCursor || loading || loadingMore) return;
    if (!debouncedQuery || debouncedQuery.length < 2) return;

    setLoadingMore(true);
    setError('');

    const params = new URLSearchParams({
      q: debouncedQuery,
      limit: String(SEARCH_PAGE_LIMIT),
      cursor: nextCursor,
    });

    try {
      const result = await apiRequest(`/posts/search?${params.toString()}`);
      const incomingItems = Array.isArray(result?.items) ? result.items : [];

      setItems((prev) => {
        if (!incomingItems.length) return prev;
        const existingIds = new Set(prev.map((item) => String(item.id)));
        const merged = [...prev];
        for (const item of incomingItems) {
          if (!item?.id) continue;
          const itemId = String(item.id);
          if (existingIds.has(itemId)) continue;
          existingIds.add(itemId);
          merged.push(item);
        }
        return merged;
      });
      setNextCursor(parseNextCursor(result));
    } catch (requestError) {
      setError(requestError.message || 'Could not load more results.');
    } finally {
      setLoadingMore(false);
    }
  }

  function handlePostUpdated(postId, patch) {
    setItems((prev) => prev.map((item) => (item.id === postId ? { ...item, ...patch } : item)));
  }

  function handlePostDeleted(postId) {
    setItems((prev) => prev.filter((item) => item.id !== postId));
  }

  return (
    <div className="home-feed-page search-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      <section className="panel feed-panel search-panel">
        <div className="panel-header feed-header">
          <div>
            <p className="eyebrow">Explore</p>
            <h3>Search Posts</h3>
          </div>
          <div className="header-actions">
            <span className="pill">
              {loading ? 'Searching...' : `${items.length} result(s)`}
            </span>
          </div>
        </div>

        {!q ? (
          <div className="empty-state">
            <h4>Start searching</h4>
            <p>Use the top search bar to find posts by title, summary, or tags.</p>
          </div>
        ) : q.length < 2 ? (
          <div className="empty-state">
            <h4>Keep typing</h4>
            <p>Search query must be at least 2 characters.</p>
          </div>
        ) : (
          <>
            <p className="search-query-line">
              Results for <strong>"{q}"</strong>
            </p>

            {error && (
              <div className="inline-alert" role="alert">
                <p>{error}</p>
              </div>
            )}

            {loading ? (
              <div className="skeleton-grid" aria-hidden="true">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div className="feed-card skeleton-card" key={`search-skeleton-${index}`} />
                ))}
              </div>
            ) : items.length === 0 && !error ? (
              <div className="empty-state">
                <h4>No results for "{q}"</h4>
                <p>Try different keywords or a shorter phrase.</p>
              </div>
            ) : (
              <>
                <div className="feed-grid search-results-grid">
                  {items.map((item, index) => (
                    <PostResultCard
                      key={item.id || `search-item-${index}`}
                      post={item}
                      index={index}
                      onPostUpdated={handlePostUpdated}
                      onPostDeleted={handlePostDeleted}
                      onActionFeedback={setBanner}
                    />
                  ))}
                </div>

                {nextCursor && (
                  <div className="search-load-more-row">
                    <button
                      type="button"
                      className="btn btn-soft search-load-more-btn"
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                    >
                      {loadingMore ? 'Loading more...' : 'Load more'}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
