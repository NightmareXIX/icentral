const DEFAULT_POST_TYPE_ICON_KEY = 'default';

const POST_TYPE_TO_ICON_KEY = Object.freeze({
  ANNOUNCEMENT: 'announcement',
  EVENT: 'event',
  EVENT_RECAP: 'event',
  JOB: 'job',
  GENERAL: 'discussion',
  DISCUSSION: 'discussion',
  COLLAB: 'discussion',
});

const POST_TYPE_ICON_PATHS = Object.freeze({
  announcement: Object.freeze([
    'M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7',
    'M13.73 21a2 2 0 0 1-3.46 0',
  ]),
  event: Object.freeze([
    'M8 2v4',
    'M16 2v4',
    'M3 10h18',
    'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  ]),
  job: Object.freeze([
    'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
    'M3 12h18',
    'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  ]),
  discussion: Object.freeze([
    'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  ]),
  default: Object.freeze([
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
    'M14 2v6h6',
    'M16 13H8',
    'M16 17H8',
    'M10 9H8',
  ]),
});

function normalizePostType(type) {
  return String(type || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

export function getPostTypeIconKey(type) {
  const normalizedType = normalizePostType(type);
  return POST_TYPE_TO_ICON_KEY[normalizedType] || DEFAULT_POST_TYPE_ICON_KEY;
}

export function getPostTypeIconPaths(type) {
  const iconKey = getPostTypeIconKey(type);
  return POST_TYPE_ICON_PATHS[iconKey] || POST_TYPE_ICON_PATHS[DEFAULT_POST_TYPE_ICON_KEY];
}
