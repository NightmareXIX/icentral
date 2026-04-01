import { useEffect, useState } from 'react';
import {
  COLLAB_CATEGORIES,
  COLLAB_MODES,
  updateCollabPost,
} from '../../utils/collabApi';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseCsvValues(value) {
  const seen = new Set();
  const result = [];

  for (const part of String(value || '').split(',')) {
    const normalized = normalizeText(part);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function toDateValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function buildDeadlineIso(dateString) {
  const trimmed = normalizeText(dateString);
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T23:59:59`;
  return trimmed;
}

function buildInitialForm(post) {
  return {
    title: normalizeText(post?.title),
    category: normalizeText(post?.category) || COLLAB_CATEGORIES[0],
    summary: normalizeText(post?.summary),
    description: normalizeText(post?.description),
    requiredSkills: Array.isArray(post?.requiredSkills) ? post.requiredSkills.join(', ') : '',
    timeCommitmentHoursPerWeek: Number.isFinite(Number(post?.timeCommitmentHoursPerWeek))
      ? String(Math.max(1, Math.trunc(Number(post.timeCommitmentHoursPerWeek))))
      : '',
    duration: normalizeText(post?.duration),
    mode: normalizeText(post?.mode) || 'HYBRID',
    openings: Number.isFinite(Number(post?.openings))
      ? String(Math.max(1, Math.trunc(Number(post.openings))))
      : '1',
    joinUntil: toDateValue(post?.joinUntil),
    preferredBackground: normalizeText(post?.preferredBackground),
    tags: Array.isArray(post?.tags) ? post.tags.join(', ') : '',
  };
}

export default function CollabPostEditModal({
  open,
  post,
  onClose,
  onSaved,
  onFeedback,
}) {
  const [formState, setFormState] = useState(() => buildInitialForm(post));
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setFormState(buildInitialForm(post));
    setFieldErrors({});
    setSubmitError('');
    setSubmitting(false);
  }, [post]);

  useEffect(() => {
    if (!open) return undefined;

    function handleEscape(event) {
      if (event.key !== 'Escape' || submitting) return;
      onClose?.();
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [open, onClose, submitting]);

  if (!open || !post?.id) return null;

  function updateField(field, value) {
    setFormState((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setSubmitError('');
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const errors = {};
    const requiredSkills = parseCsvValues(formState.requiredSkills);
    const tags = parseCsvValues(formState.tags);
    const title = normalizeText(formState.title);
    const summary = normalizeText(formState.summary);
    const description = normalizeText(formState.description);
    const duration = normalizeText(formState.duration);
    const preferredBackground = normalizeText(formState.preferredBackground);
    const timeCommitmentHoursPerWeek = Math.trunc(Number(formState.timeCommitmentHoursPerWeek));
    const openings = Math.trunc(Number(formState.openings));
    const joinUntil = buildDeadlineIso(formState.joinUntil);

    if (!title) errors.title = 'Title is required.';
    if (!formState.category) errors.category = 'Category is required.';
    if (!summary) errors.summary = 'Summary is required.';
    if (!description) errors.description = 'Description is required.';
    if (!requiredSkills.length) errors.requiredSkills = 'At least one required skill is required.';
    if (!duration) errors.duration = 'Expected timeline is required.';
    if (!Number.isFinite(timeCommitmentHoursPerWeek) || timeCommitmentHoursPerWeek <= 0) {
      errors.timeCommitmentHoursPerWeek = 'Time commitment must be a positive number.';
    }
    if (!Number.isFinite(openings) || openings <= 0) {
      errors.openings = 'Open positions must be at least 1.';
    }
    if (!formState.mode) errors.mode = 'Mode is required.';

    if (joinUntil) {
      const parsed = new Date(joinUntil);
      if (Number.isNaN(parsed.getTime())) {
        errors.joinUntil = 'Deadline is invalid.';
      } else if (parsed.getTime() < Date.now()) {
        errors.joinUntil = 'Deadline should be in the future.';
      }
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError('');

    try {
      const updatedPost = await updateCollabPost(post.id, {
        title,
        category: formState.category,
        summary,
        description,
        requiredSkills,
        timeCommitmentHoursPerWeek,
        duration,
        mode: formState.mode,
        openings,
        joinUntil,
        preferredBackground,
        tags,
      });
      await onSaved?.(updatedPost);
      onFeedback?.({ type: 'success', message: 'Collaboration post updated.' });
      onClose?.();
    } catch (error) {
      const message = error instanceof Error
        ? `Could not update collaboration post: ${error.message}`
        : 'Could not update collaboration post.';
      setSubmitError(message);
      onFeedback?.({ type: 'error', message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="profile-edit-backdrop post-edit-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Edit collaboration post"
      onClick={() => {
        if (submitting) return;
        onClose?.();
      }}
    >
      <section
        className="panel profile-edit-modal collab-create-modal post-edit-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">Edit</p>
            <h3>Update Collaboration Post</h3>
            <p className="post-edit-intro">
              Refine the owner-controlled collaboration details while keeping moderation controls and request workflows intact.
            </p>
          </div>
          <button type="button" className="btn btn-soft" onClick={() => onClose?.()} disabled={submitting}>
            Close
          </button>
        </div>

        <div className="post-edit-chip-row">
          <span className="pill">{post?.category || 'Collaboration'}</span>
          <span className="pill">{String(post?.status || 'OPEN').toUpperCase()}</span>
        </div>

        <form className="stacked-form collab-create-form post-edit-form" onSubmit={handleSubmit}>
          <div className="job-form-block">
            <div className="job-form-block-head">
              <p className="eyebrow">Core Information</p>
              <h4>Opportunity Basics</h4>
            </div>

            <label>
              <span>Title <strong className="required-marker">*</strong></span>
              <input
                type="text"
                value={formState.title}
                onChange={(event) => updateField('title', event.target.value)}
                disabled={submitting}
              />
              {fieldErrors.title && <small className="field-error">{fieldErrors.title}</small>}
            </label>

            <div className="field-row two-col">
              <label>
                <span>Category <strong className="required-marker">*</strong></span>
                <select
                  value={formState.category}
                  onChange={(event) => updateField('category', event.target.value)}
                  disabled={submitting}
                >
                  {COLLAB_CATEGORIES.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
                {fieldErrors.category && <small className="field-error">{fieldErrors.category}</small>}
              </label>

              <label>
                <span>Mode <strong className="required-marker">*</strong></span>
                <select
                  value={formState.mode}
                  onChange={(event) => updateField('mode', event.target.value)}
                  disabled={submitting}
                >
                  {COLLAB_MODES.map((mode) => (
                    <option key={mode} value={mode}>{mode}</option>
                  ))}
                </select>
                {fieldErrors.mode && <small className="field-error">{fieldErrors.mode}</small>}
              </label>
            </div>

            <label>
              <span>Summary <strong className="required-marker">*</strong></span>
              <textarea
                rows={2}
                value={formState.summary}
                onChange={(event) => updateField('summary', event.target.value)}
                disabled={submitting}
              />
              {fieldErrors.summary && <small className="field-error">{fieldErrors.summary}</small>}
            </label>

            <label>
              <span>Description <strong className="required-marker">*</strong></span>
              <textarea
                rows={5}
                value={formState.description}
                onChange={(event) => updateField('description', event.target.value)}
                disabled={submitting}
              />
              {fieldErrors.description && <small className="field-error">{fieldErrors.description}</small>}
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
                value={formState.requiredSkills}
                onChange={(event) => updateField('requiredSkills', event.target.value)}
                disabled={submitting}
              />
              <small className="composer-tag-hint">Use comma-separated values for skill tags.</small>
              {fieldErrors.requiredSkills && <small className="field-error">{fieldErrors.requiredSkills}</small>}
            </label>

            <div className="field-row two-col">
              <label>
                <span>Time commitment (hours/week) <strong className="required-marker">*</strong></span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={formState.timeCommitmentHoursPerWeek}
                  onChange={(event) => updateField('timeCommitmentHoursPerWeek', event.target.value)}
                  disabled={submitting}
                />
                {fieldErrors.timeCommitmentHoursPerWeek && (
                  <small className="field-error">{fieldErrors.timeCommitmentHoursPerWeek}</small>
                )}
              </label>

              <label>
                <span>Open positions <strong className="required-marker">*</strong></span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={formState.openings}
                  onChange={(event) => updateField('openings', event.target.value)}
                  disabled={submitting}
                />
                {fieldErrors.openings && <small className="field-error">{fieldErrors.openings}</small>}
              </label>
            </div>

            <label>
              <span>Expected timeline <strong className="required-marker">*</strong></span>
              <input
                type="text"
                value={formState.duration}
                onChange={(event) => updateField('duration', event.target.value)}
                disabled={submitting}
              />
              {fieldErrors.duration && <small className="field-error">{fieldErrors.duration}</small>}
            </label>

            <div className="field-row two-col">
              <label>
                <span>Join deadline</span>
                <input
                  type="date"
                  value={formState.joinUntil}
                  onChange={(event) => updateField('joinUntil', event.target.value)}
                  disabled={submitting}
                />
                {fieldErrors.joinUntil && <small className="field-error">{fieldErrors.joinUntil}</small>}
              </label>

              <label>
                <span>Preferred background</span>
                <input
                  type="text"
                  value={formState.preferredBackground}
                  onChange={(event) => updateField('preferredBackground', event.target.value)}
                  disabled={submitting}
                />
              </label>
            </div>

            <label>
              <span>Additional tags</span>
              <input
                type="text"
                value={formState.tags}
                onChange={(event) => updateField('tags', event.target.value)}
                disabled={submitting}
              />
            </label>
          </div>

          {submitError && <div className="field-error post-edit-submit-error">{submitError}</div>}

          <div className="feed-card-actions collab-create-actions">
            <button type="button" className="btn btn-soft" onClick={() => onClose?.()} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary-solid" disabled={submitting}>
              {submitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
