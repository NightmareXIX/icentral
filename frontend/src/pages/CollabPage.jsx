import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import CollabPostCard from '../components/posts/CollabPostCard';
import {
  COLLAB_CATEGORIES,
  COLLAB_MODES,
  COLLAB_STATUSES,
  createCollabPost,
  getCollabOpeningsLeft,
  getCollabPendingRequestCount,
  listCollabPosts,
} from '../utils/collabApi';

const SORT_OPTIONS = {
  OPEN_RECENT: 'OPEN_RECENT',
  NEWEST: 'NEWEST',
  DEADLINE: 'DEADLINE',
  OPENINGS: 'OPENINGS',
};

const initialFormState = {
  title: '',
  category: COLLAB_CATEGORIES[0],
  summary: '',
  description: '',
  requiredSkills: '',
  timeCommitmentHoursPerWeek: '',
  duration: '',
  mode: 'HYBRID',
  openings: '1',
  joinUntil: '',
  preferredBackground: '',
  tags: '',
};

const initialFilters = {
  category: '',
  status: '',
  mode: '',
  skillTag: '',
  sortBy: SORT_OPTIONS.OPEN_RECENT,
};

function parseCsvValues(value) {
  const unique = new Set();
  for (const segment of String(value || '').split(',')) {
    const normalized = segment.trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
}

function getCreatedAtTime(post) {
  const timestamp = Number(new Date(post?.createdAt || 0));
  if (Number.isNaN(timestamp)) return 0;
  return timestamp;
}

function getDeadlineTime(post) {
  if (!post?.joinUntil) return null;
  const timestamp = Number(new Date(post.joinUntil));
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isOpen(post) {
  return String(post?.status || '').toUpperCase() === COLLAB_STATUSES.OPEN;
}

function compareByOpenThenRecent(a, b) {
  const aOpen = isOpen(a) ? 1 : 0;
  const bOpen = isOpen(b) ? 1 : 0;
  if (aOpen !== bOpen) return bOpen - aOpen;
  return getCreatedAtTime(b) - getCreatedAtTime(a);
}

function compareByDeadline(a, b) {
  const openRank = compareByOpenThenRecent(a, b);
  if (openRank !== 0) return openRank;

  const aDeadline = getDeadlineTime(a);
  const bDeadline = getDeadlineTime(b);

  if (aDeadline === null && bDeadline === null) {
    return getCreatedAtTime(b) - getCreatedAtTime(a);
  }
  if (aDeadline === null) return 1;
  if (bDeadline === null) return -1;
  if (aDeadline !== bDeadline) return aDeadline - bDeadline;
  return getCreatedAtTime(b) - getCreatedAtTime(a);
}

function compareByOpenings(a, b) {
  const openRank = compareByOpenThenRecent(a, b);
  if (openRank !== 0) return openRank;
  const openingDelta = getCollabOpeningsLeft(b) - getCollabOpeningsLeft(a);
  if (openingDelta !== 0) return openingDelta;
  return getCreatedAtTime(b) - getCreatedAtTime(a);
}

function normalizeSort(value) {
  if (value === SORT_OPTIONS.NEWEST) return SORT_OPTIONS.NEWEST;
  if (value === SORT_OPTIONS.DEADLINE) return SORT_OPTIONS.DEADLINE;
  if (value === SORT_OPTIONS.OPENINGS) return SORT_OPTIONS.OPENINGS;
  return SORT_OPTIONS.OPEN_RECENT;
}

function buildDeadlineIso(dateString) {
  const trimmed = String(dateString || '').trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T23:59:59`;
  return trimmed;
}

export default function CollabPage() {
  const { isAuthenticated } = useAuth();

  const [posts, setPosts] = useState([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formState, setFormState] = useState(initialFormState);
  const [formErrors, setFormErrors] = useState({});
  const [filters, setFilters] = useState(initialFilters);
  const [banner, setBanner] = useState({ type: 'idle', message: '' });

  const loadPosts = useCallback(async (options = {}) => {
    const { withLoading = true } = options;
    if (withLoading) setLoadingPosts(true);
    try {
      const result = await listCollabPosts({
        limit: 100,
        sortBy: SORT_OPTIONS.NEWEST,
      });
      const items = Array.isArray(result?.items) ? result.items : [];
      setPosts(items);
    } catch (error) {
      setBanner({ type: 'error', message: `Could not load collaboration posts: ${error.message}` });
    } finally {
      if (withLoading) setLoadingPosts(false);
    }
  }, []);

  useEffect(() => {
    loadPosts();
  }, [loadPosts]);

  const stats = useMemo(() => {
    const openPosts = posts.filter((post) => isOpen(post)).length;
    const totalOpeningsLeft = posts.reduce((sum, post) => sum + getCollabOpeningsLeft(post), 0);
    const pendingRequests = posts.reduce((sum, post) => sum + getCollabPendingRequestCount(post), 0);
    return {
      openPosts,
      totalOpeningsLeft,
      pendingRequests,
    };
  }, [posts]);

  const filteredPosts = useMemo(() => {
    const categoryFilter = String(filters.category || '').trim();
    const statusFilter = String(filters.status || '').trim().toUpperCase();
    const modeFilter = String(filters.mode || '').trim().toUpperCase();
    const skillTagFilter = String(filters.skillTag || '').trim().toLowerCase();
    const sortBy = normalizeSort(filters.sortBy);

    let filtered = posts.filter((post) => {
      if (categoryFilter && post.category !== categoryFilter) return false;
      if (statusFilter && String(post.status || '').toUpperCase() !== statusFilter) return false;
      if (modeFilter && String(post.mode || '').toUpperCase() !== modeFilter) return false;

      if (skillTagFilter) {
        const searchableSkills = Array.isArray(post.requiredSkills) ? post.requiredSkills : [];
        const searchableTags = Array.isArray(post.tags) ? post.tags : [];
        const haystack = [...searchableSkills, ...searchableTags].join(' ').toLowerCase();
        if (!haystack.includes(skillTagFilter)) return false;
      }

      return true;
    });

    filtered = filtered.slice().sort((a, b) => {
      if (sortBy === SORT_OPTIONS.NEWEST) return getCreatedAtTime(b) - getCreatedAtTime(a);
      if (sortBy === SORT_OPTIONS.DEADLINE) return compareByDeadline(a, b);
      if (sortBy === SORT_OPTIONS.OPENINGS) return compareByOpenings(a, b);
      return compareByOpenThenRecent(a, b);
    });

    return filtered;
  }, [filters, posts]);

  function updateFormField(field, value) {
    setFormState((prev) => ({ ...prev, [field]: value }));
  }

  function updateFilter(field, value) {
    setFilters((prev) => ({ ...prev, [field]: value }));
  }

  function clearFilters() {
    setFilters(initialFilters);
  }

  async function refreshPosts() {
    await loadPosts({ withLoading: true });
  }

  function validateForm() {
    const nextErrors = {};
    const skills = parseCsvValues(formState.requiredSkills);
    const tags = parseCsvValues(formState.tags);
    const title = formState.title.trim();
    const summary = formState.summary.trim();
    const description = formState.description.trim();
    const duration = formState.duration.trim();
    const preferredBackground = formState.preferredBackground.trim();
    const timeCommitment = Math.trunc(Number(formState.timeCommitmentHoursPerWeek));
    const openings = Math.trunc(Number(formState.openings));
    const joinUntil = buildDeadlineIso(formState.joinUntil);

    if (!title) nextErrors.title = 'Title is required.';
    if (!formState.category) nextErrors.category = 'Category is required.';
    if (!summary) nextErrors.summary = 'Summary is required.';
    if (!description) nextErrors.description = 'Description is required.';
    if (!skills.length) nextErrors.requiredSkills = 'At least one required skill is required.';
    if (!duration) nextErrors.duration = 'Expected timeline is required.';
    if (!Number.isFinite(timeCommitment) || timeCommitment <= 0) {
      nextErrors.timeCommitmentHoursPerWeek = 'Time commitment must be a positive number.';
    }
    if (!Number.isFinite(openings) || openings <= 0) {
      nextErrors.openings = 'Open positions must be at least 1.';
    }
    if (!formState.mode) nextErrors.mode = 'Mode is required.';

    if (joinUntil) {
      const parsed = new Date(joinUntil);
      if (Number.isNaN(parsed.getTime())) {
        nextErrors.joinUntil = 'Deadline is invalid.';
      } else {
        const now = Date.now();
        if (parsed.getTime() < now) {
          nextErrors.joinUntil = 'Deadline should be in the future.';
        }
      }
    }

    return {
      errors: nextErrors,
      payload: {
        title,
        category: formState.category,
        summary,
        description,
        requiredSkills: skills,
        timeCommitmentHoursPerWeek: timeCommitment,
        duration,
        mode: formState.mode,
        openings,
        joinUntil,
        preferredBackground,
        tags,
      },
    };
  }

  async function handleCreatePost(event) {
    event.preventDefault();
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to create collaboration posts.' });
      return;
    }

    const { errors, payload } = validateForm();
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await createCollabPost(payload);
      setFormState(initialFormState);
      setFormErrors({});
      setBanner({ type: 'success', message: 'Collaboration post published.' });
      await loadPosts({ withLoading: false });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not create collaboration post: ${error.message}` });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="home-feed-page collab-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      <section className="panel collab-overview-panel">
        <div className="collab-overview-head">
          <div>
            <p className="eyebrow">Collaborate</p>
            <h2>Academic and Professional Collaboration Hub</h2>
            <p>Create structured collaboration posts for research, thesis, project teams, and study groups.</p>
          </div>
          <div className="collab-overview-stats">
            <div className="collab-overview-stat-card">
              <span>Open opportunities</span>
              <strong>{stats.openPosts}</strong>
            </div>
            <div className="collab-overview-stat-card">
              <span>Open positions</span>
              <strong>{stats.totalOpeningsLeft}</strong>
            </div>
            <div className="collab-overview-stat-card">
              <span>Pending requests</span>
              <strong>{stats.pendingRequests}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="collab-top-grid">
        <section className="panel composer-panel collab-composer-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Create</p>
              <h3>Post a Collaboration Opportunity</h3>
            </div>
            <span className="pill">Collaboration only</span>
          </div>

          {!isAuthenticated && (
            <div className="inline-alert warn-alert">
              <p>
                Guest mode is active. You can browse collaboration posts, but posting requires authentication.
                <Link to="/login"> Sign in</Link> or <Link to="/signup"> create an account</Link>.
              </p>
            </div>
          )}

          <form className="stacked-form collab-create-form" onSubmit={handleCreatePost}>
            <div className="job-form-block">
              <div className="job-form-block-head">
                <p className="eyebrow">Core Information</p>
                <h4>Opportunity Basics</h4>
              </div>

              <label>
                <span>Title <strong className="required-marker">*</strong></span>
                <input
                  type="text"
                  placeholder="e.g. Research Assistant for NLP literature review"
                  value={formState.title}
                  onChange={(event) => updateFormField('title', event.target.value)}
                  disabled={!isAuthenticated || submitting}
                  aria-invalid={Boolean(formErrors.title)}
                />
                {formErrors.title && <small className="field-error">{formErrors.title}</small>}
              </label>

              <div className="field-row two-col">
                <label>
                  <span>Category <strong className="required-marker">*</strong></span>
                  <select
                    value={formState.category}
                    onChange={(event) => updateFormField('category', event.target.value)}
                    disabled={!isAuthenticated || submitting}
                    aria-invalid={Boolean(formErrors.category)}
                  >
                    {COLLAB_CATEGORIES.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                  {formErrors.category && <small className="field-error">{formErrors.category}</small>}
                </label>

                <label>
                  <span>Mode <strong className="required-marker">*</strong></span>
                  <select
                    value={formState.mode}
                    onChange={(event) => updateFormField('mode', event.target.value)}
                    disabled={!isAuthenticated || submitting}
                    aria-invalid={Boolean(formErrors.mode)}
                  >
                    {COLLAB_MODES.map((mode) => (
                      <option key={mode} value={mode}>{mode}</option>
                    ))}
                  </select>
                  {formErrors.mode && <small className="field-error">{formErrors.mode}</small>}
                </label>
              </div>

              <label>
                <span>Summary <strong className="required-marker">*</strong></span>
                <textarea
                  rows={2}
                  placeholder="Briefly explain the goal and scope of this collaboration."
                  value={formState.summary}
                  onChange={(event) => updateFormField('summary', event.target.value)}
                  disabled={!isAuthenticated || submitting}
                  aria-invalid={Boolean(formErrors.summary)}
                />
                {formErrors.summary && <small className="field-error">{formErrors.summary}</small>}
              </label>

              <label>
                <span>Description <strong className="required-marker">*</strong></span>
                <textarea
                  rows={5}
                  placeholder="Provide full context, expectations, deliverables, and collaboration workflow."
                  value={formState.description}
                  onChange={(event) => updateFormField('description', event.target.value)}
                  disabled={!isAuthenticated || submitting}
                  aria-invalid={Boolean(formErrors.description)}
                />
                {formErrors.description && <small className="field-error">{formErrors.description}</small>}
              </label>
            </div>

            <div className="job-form-block">
              <div className="job-form-block-head">
                <p className="eyebrow">Participation Details</p>
                <h4>Skills and Commitment</h4>
              </div>

              <label>
                <span>Required skills <strong className="required-marker">*</strong></span>
                <input
                  type="text"
                  placeholder="Comma separated, e.g. Python, Research Writing, React"
                  value={formState.requiredSkills}
                  onChange={(event) => updateFormField('requiredSkills', event.target.value)}
                  disabled={!isAuthenticated || submitting}
                  aria-invalid={Boolean(formErrors.requiredSkills)}
                />
                <small className="composer-tag-hint">Use comma-separated values for skill tags.</small>
                {formErrors.requiredSkills && <small className="field-error">{formErrors.requiredSkills}</small>}
              </label>

              <div className="field-row two-col">
                <label>
                  <span>Time commitment (hours/week) <strong className="required-marker">*</strong></span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="e.g. 6"
                    value={formState.timeCommitmentHoursPerWeek}
                    onChange={(event) => updateFormField('timeCommitmentHoursPerWeek', event.target.value)}
                    disabled={!isAuthenticated || submitting}
                    aria-invalid={Boolean(formErrors.timeCommitmentHoursPerWeek)}
                  />
                  {formErrors.timeCommitmentHoursPerWeek && (
                    <small className="field-error">{formErrors.timeCommitmentHoursPerWeek}</small>
                  )}
                </label>

                <label>
                  <span>Open positions <strong className="required-marker">*</strong></span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="e.g. 2"
                    value={formState.openings}
                    onChange={(event) => updateFormField('openings', event.target.value)}
                    disabled={!isAuthenticated || submitting}
                    aria-invalid={Boolean(formErrors.openings)}
                  />
                  {formErrors.openings && <small className="field-error">{formErrors.openings}</small>}
                </label>
              </div>

              <label>
                <span>Expected timeline <strong className="required-marker">*</strong></span>
                <input
                  type="text"
                  placeholder="e.g. 10 weeks, Semester-long, 3 months"
                  value={formState.duration}
                  onChange={(event) => updateFormField('duration', event.target.value)}
                  disabled={!isAuthenticated || submitting}
                  aria-invalid={Boolean(formErrors.duration)}
                />
                {formErrors.duration && <small className="field-error">{formErrors.duration}</small>}
              </label>

              <div className="field-row two-col">
                <label>
                  <span>Join deadline (optional)</span>
                  <input
                    type="date"
                    value={formState.joinUntil}
                    onChange={(event) => updateFormField('joinUntil', event.target.value)}
                    disabled={!isAuthenticated || submitting}
                    aria-invalid={Boolean(formErrors.joinUntil)}
                  />
                  {formErrors.joinUntil && <small className="field-error">{formErrors.joinUntil}</small>}
                </label>

                <label>
                  <span>Preferred background (optional)</span>
                  <input
                    type="text"
                    placeholder="e.g. 3rd/4th year ICE students"
                    value={formState.preferredBackground}
                    onChange={(event) => updateFormField('preferredBackground', event.target.value)}
                    disabled={!isAuthenticated || submitting}
                  />
                </label>
              </div>

              <label>
                <span>Additional tags (optional)</span>
                <input
                  type="text"
                  placeholder="Comma separated, e.g. thesis, data-science, iot"
                  value={formState.tags}
                  onChange={(event) => updateFormField('tags', event.target.value)}
                  disabled={!isAuthenticated || submitting}
                />
              </label>
            </div>

            <div className="feed-card-actions collab-create-actions">
              <button className="btn btn-primary-solid" type="submit" disabled={!isAuthenticated || submitting}>
                {submitting ? 'Publishing...' : 'Publish Collaboration Post'}
              </button>
            </div>
          </form>
        </section>
      </section>

      <section className="panel feed-panel collab-feed-panel">
        <div className="panel-header feed-header">
          <div>
            <p className="eyebrow">Discover</p>
            <h3>Collaboration Opportunities</h3>
          </div>
          <div className="header-actions">
            <span className="pill">{loadingPosts ? 'Loading...' : `${filteredPosts.length} post(s)`}</span>
            <button className="btn btn-soft" type="button" onClick={refreshPosts}>Refresh</button>
          </div>
        </div>

        <form className="feed-filters collab-feed-filters" onSubmit={(event) => event.preventDefault()}>
          <label>
            <span>Category</span>
            <select value={filters.category} onChange={(event) => updateFilter('category', event.target.value)}>
              <option value="">All categories</option>
              {COLLAB_CATEGORIES.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Status</span>
            <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
              <option value="">All statuses</option>
              <option value={COLLAB_STATUSES.OPEN}>Open</option>
              <option value={COLLAB_STATUSES.CLOSED}>Closed</option>
            </select>
          </label>

          <label>
            <span>Mode</span>
            <select value={filters.mode} onChange={(event) => updateFilter('mode', event.target.value)}>
              <option value="">All modes</option>
              {COLLAB_MODES.map((mode) => (
                <option key={mode} value={mode}>{mode}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Skill tag</span>
            <input
              type="search"
              placeholder="Filter by skill or tag"
              value={filters.skillTag}
              onChange={(event) => updateFilter('skillTag', event.target.value)}
            />
          </label>

          <label>
            <span>Sort by</span>
            <select value={filters.sortBy} onChange={(event) => updateFilter('sortBy', event.target.value)}>
              <option value={SORT_OPTIONS.OPEN_RECENT}>Open + Recent</option>
              <option value={SORT_OPTIONS.NEWEST}>Newest</option>
              <option value={SORT_OPTIONS.DEADLINE}>Nearest Deadline</option>
              <option value={SORT_OPTIONS.OPENINGS}>Open Positions</option>
            </select>
          </label>

          <div className="collab-filter-actions">
            <button className="btn btn-soft" type="button" onClick={clearFilters}>Reset</button>
          </div>
        </form>

        {loadingPosts ? (
          <div className="skeleton-grid" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, index) => (
              <div className="feed-card skeleton-card" key={`collab-skeleton-${index}`} />
            ))}
          </div>
        ) : filteredPosts.length === 0 ? (
          <div className="empty-state">
            <h4>No collaboration posts match the current filters</h4>
            <p>Try adjusting the filters or publish a new collaboration opportunity above.</p>
          </div>
        ) : (
          <div className="feed-grid collab-feed-grid">
            {filteredPosts.map((post, index) => (
              <CollabPostCard key={post.id} post={post} index={index} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
