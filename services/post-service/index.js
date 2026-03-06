const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { query: searchQuery, isDbConfigured: isSearchDbConfigured, closePool: closeSearchDbPool } = require('./db');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = Number(process.env.PORT) || 3002;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_MAX_QUERY_LENGTH = 80;

const CONFIG = {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
    schema: process.env.POST_SERVICE_SCHEMA || 'public',
    tables: {
        posts: process.env.POSTS_TABLE || 'posts',
        users: process.env.USERS_TABLE || 'users',
        tags: process.env.TAGS_TABLE || 'tags',
        postTags: process.env.POST_TAGS_TABLE || 'post_tags',
        postRefs: process.env.POST_REFS_TABLE || 'post_refs',
        postVotes: process.env.POST_VOTES_TABLE || 'post_votes',
        postComments: process.env.POST_COMMENTS_TABLE || 'post_comments',
        alumniVerificationApplications: process.env.ALUMNI_VERIFICATION_TABLE || 'alumni_verification_applications',
    },
    feedDefaultLimit: Number(process.env.POST_FEED_DEFAULT_LIMIT) || 20,
    feedMaxLimit: Number(process.env.POST_FEED_MAX_LIMIT) || 100,
    archiveIntervalMs: Number(process.env.POST_ARCHIVE_INTERVAL_MS) || 0,
    jwtSecret: process.env.JWT_SECRET || 'HelloWorldKey',
};

function quoteIdentifier(value, label) {
    const normalized = String(value || '').trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalized)) {
        throw new Error(`Invalid SQL identifier for ${label}: "${value}"`);
    }
    return `"${normalized}"`;
}

const DB_TABLE_IDENTIFIERS = (() => {
    const schema = quoteIdentifier(CONFIG.schema, 'schema');
    return {
        posts: `${schema}.${quoteIdentifier(CONFIG.tables.posts, 'posts table')}`,
        tags: `${schema}.${quoteIdentifier(CONFIG.tables.tags, 'tags table')}`,
        postTags: `${schema}.${quoteIdentifier(CONFIG.tables.postTags, 'post_tags table')}`,
    };
})();

const supabase = (CONFIG.supabaseUrl && CONFIG.supabaseKey)
    ? createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
        auth: { persistSession: false },
        db: { schema: CONFIG.schema },
    })
    : null;

function isSupabaseConfigured() {
    return Boolean(supabase);
}

function isMissingTableError(error) {
    return error?.code === '42P01';
}

function parseBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function parseIntInRange(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function slugify(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function sanitizeSearchTerm(term) {
    return String(term)
        .trim()
        .replace(/[(),]/g, ' ')
        .replace(/\s+/g, ' ');
}

function normalizeSearchQuery(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ');
}

function encodeSearchCursor({ rank, createdAt, id }) {
    const payload = {
        v: 1,
        rank: Number(rank),
        createdAt: createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString(),
        id: String(id),
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeSearchCursor(value) {
    if (!value) return { value: null };

    const raw = String(value).trim();
    if (!raw) return { value: null };

    let decodedText = '';
    try {
        decodedText = Buffer.from(raw, 'base64url').toString('utf8');
    } catch {
        try {
            decodedText = Buffer.from(raw, 'base64').toString('utf8');
        } catch {
            return { error: 'cursor is invalid' };
        }
    }

    try {
        const parsed = JSON.parse(decodedText);
        const rank = Number(parsed?.rank);
        const createdAt = new Date(parsed?.createdAt);
        const id = normalizeText(parsed?.id);

        if (!Number.isFinite(rank)) {
            return { error: 'cursor is invalid' };
        }

        if (Number.isNaN(createdAt.getTime())) {
            return { error: 'cursor is invalid' };
        }

        if (!id) {
            return { error: 'cursor is invalid' };
        }

        return {
            value: {
                rank,
                createdAt: createdAt.toISOString(),
                id,
            },
        };
    } catch {
        return { error: 'cursor is invalid' };
    }
}

function parseSearchRequest(query = {}) {
    const errors = [];
    const q = normalizeSearchQuery(query.q);
    const limit = parseIntInRange(query.limit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
    const cursorResult = decodeSearchCursor(query.cursor);

    if (!q) {
        errors.push('q is required');
    } else if (q.length < SEARCH_MIN_QUERY_LENGTH) {
        errors.push(`q must be at least ${SEARCH_MIN_QUERY_LENGTH} characters`);
    } else if (q.length > SEARCH_MAX_QUERY_LENGTH) {
        errors.push(`q must be at most ${SEARCH_MAX_QUERY_LENGTH} characters`);
    }

    if (cursorResult.error) {
        errors.push(cursorResult.error);
    }

    return {
        q,
        limit,
        cursor: cursorResult.value || null,
        errors,
    };
}

function pickDefined(fields) {
    return Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined)
    );
}

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeDate(value, fieldName) {
    if (value === undefined) return { value: undefined };
    if (value === null || value === '') return { value: null };

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return { error: `${fieldName} must be a valid date/time string` };
    }

    return { value: date.toISOString() };
}

function mapTag(row) {
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        createdAt: row.created_at,
    };
}

function mapPost(row) {
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        summary: row.summary,
        authorId: row.author_id,
        status: row.status,
        pinned: row.pinned,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function formatSupabaseError(error) {
    if (!error) return 'Unknown database error';
    return error.message || error.details || 'Unknown database error';
}

function parseVoteInput(value) {
    if (value === undefined || value === null || value === '') {
        return { error: 'vote is required' };
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'up', 'upvote', 'true'].includes(normalized)) return { value: 1 };
    if (['-1', 'down', 'downvote'].includes(normalized)) return { value: -1 };
    if (['0', 'none', 'clear', 'neutral', 'remove', 'false'].includes(normalized)) return { value: 0 };
    return { error: 'vote must be one of: up, down, none' };
}

function parseCommentInput(body = {}) {
    const content = normalizeText(body.content ?? body.comment ?? body.text);
    const errors = [];
    if (!content) {
        errors.push('content is required');
    } else if (content.length > 5000) {
        errors.push('content is too long');
    }

    return { content, errors };
}

function mapComment(row, author = null) {
    return {
        id: row.id,
        postId: row.post_id,
        authorId: row.author_id,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        author,
    };
}

function dbUnavailable(res) {
    return res.status(503).json({
        error: 'Post service database is not configured',
        requiredEnv: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    });
}

function searchDbUnavailable(res) {
    return res.status(503).json({
        error: 'Post search database is not configured',
        requiredEnv: ['SUPABASE_DB_URL'],
    });
}

function socialSchemaError(res) {
    return res.status(500).json({
        error: `Missing social tables. Run services/post-service/schema.sql first.`,
    });
}

function ensureDb(req, res, next) {
    if (!isSupabaseConfigured()) {
        return dbUnavailable(res);
    }
    return next();
}

function ensureSearchDb(req, res, next) {
    if (!isSearchDbConfigured()) {
        return searchDbUnavailable(res);
    }
    return next();
}

function ensureAuthenticated(req, res, next) {
    const requestUser = getRequestUser(req);
    if (!requestUser?.id) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    req.requestUser = requestUser;
    return next();
}

function getRequestUser(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;

    const token = header.slice(7).trim();
    if (!token) return null;

    try {
        return jwt.verify(token, CONFIG.jwtSecret);
    } catch {
        return null;
    }
}

function isModeratorRole(role) {
    const normalized = String(role || '').toLowerCase();
    return normalized === 'admin' || normalized === 'faculty';
}

function isAlumniRole(role) {
    return String(role || '').toLowerCase() === 'alumni';
}

function canCreateAnnouncement(role) {
    return isModeratorRole(role);
}

function canCreateJobAsBypassRole(role) {
    return isModeratorRole(role);
}

function resolveVerificationStatus(rows) {
    const applications = Array.isArray(rows) ? rows : [];
    if (applications.some((item) => item.status === 'approved')) return 'approved';
    if (applications.some((item) => item.status === 'pending')) return 'pending';
    if (applications.some((item) => item.status === 'rejected')) return 'rejected';
    return 'not_submitted';
}

async function getAlumniVerificationStatus(applicantId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.alumniVerificationApplications)
        .select('status, created_at')
        .eq('applicant_id', applicantId)
        .order('created_at', { ascending: false });

    if (error) {
        throw error;
    }

    return resolveVerificationStatus(data || []);
}

function buildPostPayload(body, { partial = false } = {}) {
    const errors = [];

    const expiresAtResult = normalizeDate(
        body.expiresAt !== undefined ? body.expiresAt : body.expires_at,
        'expiresAt'
    );

    if (expiresAtResult.error) {
        errors.push(expiresAtResult.error);
    }

    const statusInput = body.status;
    const archiveInput = body.archive;
    let status = statusInput;

    if (archiveInput === true || archiveInput === 'true' || archiveInput === 1 || archiveInput === '1') {
        status = 'archived';
    }

    const postFields = pickDefined({
        type: body.type,
        title: body.title,
        summary: body.summary,
        author_id: body.authorId ?? body.author_id,
        status: status,
        pinned: body.pinned !== undefined ? parseBool(body.pinned) : undefined,
        expires_at: expiresAtResult.value,
    });

    if (!partial) {
        if (!postFields.type || typeof postFields.type !== 'string') {
            errors.push('type is required');
        }
        if (postFields.author_id !== undefined && String(postFields.author_id).trim() === '') {
            errors.push('authorId cannot be empty');
        }
        if (!postFields.status) {
            postFields.status = 'draft';
        }
        if (postFields.pinned === undefined) {
            postFields.pinned = false;
        }
    }

    if (postFields.type !== undefined && typeof postFields.type !== 'string') {
        errors.push('type must be a string');
    }
    if (postFields.title !== undefined && postFields.title !== null && typeof postFields.title !== 'string') {
        errors.push('title must be a string or null');
    }
    if (postFields.summary !== undefined && postFields.summary !== null && typeof postFields.summary !== 'string') {
        errors.push('summary must be a string or null');
    }
    if (postFields.status !== undefined && typeof postFields.status !== 'string') {
        errors.push('status must be a string');
    }

    let tagIds = [];
    let tagNames = [];
    let tagsProvided = false;

    if (Array.isArray(body.tagIds)) {
        tagsProvided = true;
        tagIds = body.tagIds.map((id) => String(id).trim()).filter(Boolean);
    }

    if (Array.isArray(body.tags)) {
        tagsProvided = true;
        if (body.tags.every((tag) => typeof tag === 'string')) {
            tagNames = body.tags.map((tag) => tag.trim()).filter(Boolean);
        } else if (body.tags.every((tag) => tag && typeof tag === 'object')) {
            tagIds = [
                ...tagIds,
                ...body.tags
                    .map((tag) => (tag.id !== undefined ? String(tag.id).trim() : ''))
                    .filter(Boolean),
            ];
            tagNames = [
                ...tagNames,
                ...body.tags
                    .map((tag) => (typeof tag.name === 'string' ? tag.name.trim() : ''))
                    .filter(Boolean),
            ];
        } else {
            errors.push('tags must be an array of strings or objects');
        }
    }

    const refInput = body.ref ?? body.postRef ?? body.post_ref;
    let ref;

    if (refInput !== undefined) {
        if (refInput === null) {
            ref = null;
        } else if (
            typeof refInput === 'object' &&
            typeof refInput.service === 'string' &&
            refInput.service.trim() &&
            refInput.entityId !== undefined
        ) {
            ref = {
                service: refInput.service.trim(),
                entity_id: String(refInput.entityId).trim(),
                metadata: (refInput.metadata && typeof refInput.metadata === 'object')
                    ? refInput.metadata
                    : {},
            };
        } else if (
            typeof refInput === 'object' &&
            typeof refInput.service === 'string' &&
            refInput.service.trim() &&
            refInput.entity_id !== undefined
        ) {
            ref = {
                service: refInput.service.trim(),
                entity_id: String(refInput.entity_id).trim(),
                metadata: (refInput.metadata && typeof refInput.metadata === 'object')
                    ? refInput.metadata
                    : {},
            };
        } else {
            errors.push('ref must include service and entityId');
        }
    }

    return {
        errors,
        postFields,
        tagsProvided,
        tagIds: [...new Set(tagIds)],
        tagNames: [...new Set(tagNames)],
        refProvided: refInput !== undefined,
        ref,
    };
}

async function archiveExpiredPosts() {
    if (!isSupabaseConfigured()) {
        return { archivedCount: 0, skipped: true };
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .update({ status: 'archived' })
        .lt('expires_at', nowIso)
        .neq('status', 'archived')
        .select('id');

    if (error) {
        throw error;
    }

    return { archivedCount: data?.length || 0 };
}

async function getPostRefs(postIds) {
    if (!postIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.postRefs)
        .select('post_id, service, entity_id, metadata, created_at')
        .in('post_id', postIds);

    if (error) {
        if (error.code === '42P01') return new Map();
        throw error;
    }

    const refsByPostId = new Map();
    for (const row of data || []) {
        const existing = refsByPostId.get(row.post_id) || [];
        existing.push({
            service: row.service,
            entityId: row.entity_id,
            metadata: row.metadata || {},
            createdAt: row.created_at,
        });
        refsByPostId.set(row.post_id, existing);
    }

    return refsByPostId;
}

async function attachTags(posts) {
    if (!posts.length) return posts;

    const postIds = posts.map((post) => post.id);
    const { data: postTagRows, error: postTagsError } = await supabase
        .from(CONFIG.tables.postTags)
        .select('post_id, tag_id')
        .in('post_id', postIds);

    if (postTagsError) {
        if (postTagsError.code === '42P01') {
            return posts.map((post) => ({ ...post, tags: [] }));
        }
        throw postTagsError;
    }

    const tagIds = [...new Set((postTagRows || []).map((row) => row.tag_id))];
    if (!tagIds.length) {
        return posts.map((post) => ({ ...post, tags: [] }));
    }

    const { data: tagRows, error: tagsError } = await supabase
        .from(CONFIG.tables.tags)
        .select('id, name, slug, created_at')
        .in('id', tagIds);

    if (tagsError) {
        if (tagsError.code === '42P01') {
            return posts.map((post) => ({ ...post, tags: [] }));
        }
        throw tagsError;
    }

    const tagMap = new Map((tagRows || []).map((tag) => [tag.id, mapTag(tag)]));
    const tagsByPostId = new Map();

    for (const row of postTagRows || []) {
        const tag = tagMap.get(row.tag_id);
        if (!tag) continue;
        const existing = tagsByPostId.get(row.post_id) || [];
        existing.push(tag);
        tagsByPostId.set(row.post_id, existing);
    }

    return posts.map((post) => ({
        ...post,
        tags: tagsByPostId.get(post.id) || [],
    }));
}

async function getUsersByIds(userIds = []) {
    if (!userIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.users)
        .select('id, full_name, email, role')
        .in('id', userIds);

    if (error) {
        if (isMissingTableError(error)) return new Map();
        throw error;
    }

    const userMap = new Map();
    for (const row of data || []) {
        userMap.set(row.id, {
            id: row.id,
            fullName: row.full_name || null,
            email: row.email || null,
            role: row.role || null,
        });
    }
    return userMap;
}

async function getVoteSummaryByPostIds(postIds = [], requestUserId = null) {
    if (!postIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.postVotes)
        .select('post_id, user_id, vote')
        .in('post_id', postIds);

    if (error) {
        if (isMissingTableError(error)) return new Map();
        throw error;
    }

    const summaryByPostId = new Map();
    for (const row of data || []) {
        const vote = Number(row.vote);
        const safeVote = vote === 1 ? 1 : vote === -1 ? -1 : 0;
        const existing = summaryByPostId.get(row.post_id) || {
            score: 0,
            voteScore: 0,
            upvoteCount: 0,
            downvoteCount: 0,
            userVote: null,
        };

        if (safeVote === 1) existing.upvoteCount += 1;
        if (safeVote === -1) existing.downvoteCount += 1;
        existing.score += safeVote;
        existing.voteScore += safeVote;

        if (requestUserId && String(row.user_id) === String(requestUserId)) {
            existing.userVote = safeVote === 1 ? 'up' : safeVote === -1 ? 'down' : null;
        }
        summaryByPostId.set(row.post_id, existing);
    }

    return summaryByPostId;
}

async function getCommentCountByPostIds(postIds = []) {
    if (!postIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.postComments)
        .select('post_id')
        .in('post_id', postIds);

    if (error) {
        if (isMissingTableError(error)) return new Map();
        throw error;
    }

    const countByPostId = new Map();
    for (const row of data || []) {
        const current = countByPostId.get(row.post_id) || 0;
        countByPostId.set(row.post_id, current + 1);
    }
    return countByPostId;
}

async function getCommentsForPost(postId, { limit = 50, offset = 0 } = {}) {
    const { data, error, count } = await supabase
        .from(CONFIG.tables.postComments)
        .select('*', { count: 'exact' })
        .eq('post_id', postId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (error) {
        throw error;
    }

    const rows = data || [];
    const authorIds = [...new Set(rows.map((row) => row.author_id).filter(Boolean))];
    const userMap = await getUsersByIds(authorIds);

    return {
        data: rows.map((row) => mapComment(row, userMap.get(row.author_id) || null)),
        pagination: {
            limit,
            offset,
            total: count ?? rows.length,
        },
    };
}

async function getPostCommentById(postId, commentId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.postComments)
        .select('*')
        .eq('id', commentId)
        .eq('post_id', postId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function enrichPosts(postRows, { requestUserId = null } = {}) {
    const mapped = postRows.map(mapPost);
    if (!mapped.length) return [];

    const withTags = await attachTags(mapped);
    const postIds = withTags.map((post) => post.id);
    const authorIds = [...new Set(withTags.map((post) => post.authorId).filter(Boolean))];
    const refsByPostId = await getPostRefs(postIds);
    const authorMap = await getUsersByIds(authorIds);
    const voteSummaryByPostId = await getVoteSummaryByPostIds(postIds, requestUserId);
    const commentCountByPostId = await getCommentCountByPostIds(postIds);

    return withTags.map((post) => {
        const voteSummary = voteSummaryByPostId.get(post.id) || {
            score: 0,
            voteScore: 0,
            upvoteCount: 0,
            downvoteCount: 0,
            userVote: null,
        };
        const commentCount = commentCountByPostId.get(post.id) || 0;
        const author = post.authorId ? (authorMap.get(post.authorId) || null) : null;

        return {
            ...post,
            author,
            authorName: author?.fullName || author?.email || null,
            refs: refsByPostId.get(post.id) || [],
            score: voteSummary.score,
            voteScore: voteSummary.voteScore,
            upvoteCount: voteSummary.upvoteCount,
            downvoteCount: voteSummary.downvoteCount,
            userVote: voteSummary.userVote,
            commentCount,
            commentsCount: commentCount,
        };
    });
}

async function ensureTagsExist(tagNames) {
    if (!tagNames.length) return [];

    const names = [...new Set(tagNames.map((tag) => tag.trim()).filter(Boolean))];
    if (!names.length) return [];

    const upsertPayload = names.map((name) => ({
        name,
        slug: slugify(name),
    }));

    const { data, error } = await supabase
        .from(CONFIG.tables.tags)
        .upsert(upsertPayload, { onConflict: 'slug' })
        .select('id, name, slug, created_at');

    if (error) {
        throw error;
    }

    return data || [];
}

async function replacePostTags(postId, tagIds = [], tagNames = []) {
    const ensuredTags = await ensureTagsExist(tagNames);
    const mergedTagIds = [
        ...new Set([
            ...tagIds.map((id) => String(id)),
            ...ensuredTags.map((tag) => String(tag.id)),
        ]),
    ];

    const { error: deleteError } = await supabase
        .from(CONFIG.tables.postTags)
        .delete()
        .eq('post_id', postId);

    if (deleteError && deleteError.code !== '42P01') {
        throw deleteError;
    }

    if (!mergedTagIds.length) {
        return;
    }

    const rows = mergedTagIds.map((tagId) => ({
        post_id: postId,
        tag_id: tagId,
    }));

    const { error: insertError } = await supabase
        .from(CONFIG.tables.postTags)
        .insert(rows);

    if (insertError) {
        throw insertError;
    }
}

async function replacePostRef(postId, ref) {
    const { error: deleteError } = await supabase
        .from(CONFIG.tables.postRefs)
        .delete()
        .eq('post_id', postId);

    if (deleteError && deleteError.code !== '42P01') {
        throw deleteError;
    }

    if (!ref) return;

    const { error: insertError } = await supabase
        .from(CONFIG.tables.postRefs)
        .insert({
            post_id: postId,
            service: ref.service,
            entity_id: ref.entity_id,
            metadata: ref.metadata || {},
        });

    if (insertError) {
        throw insertError;
    }
}

async function getPostById(postId, options = {}) {
    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('*')
        .eq('id', postId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data) return null;

    const [enriched] = await enrichPosts([data], options);
    return enriched || null;
}

async function getPostsByIdsOrdered(postIds = []) {
    if (!postIds.length) return [];

    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('*')
        .in('id', postIds);

    if (error) {
        throw error;
    }

    const rowMap = new Map((data || []).map((row) => [String(row.id), row]));
    return postIds
        .map((id) => rowMap.get(String(id)))
        .filter(Boolean);
}

function mapSearchResultItem(post = {}) {
    const score = Number.isFinite(Number(post.score)) ? Math.trunc(Number(post.score)) : 0;
    const voteScore = Number.isFinite(Number(post.voteScore)) ? Math.trunc(Number(post.voteScore)) : score;
    const upvoteCount = Number.isFinite(Number(post.upvoteCount)) ? Math.max(0, Math.trunc(Number(post.upvoteCount))) : 0;
    const downvoteCount = Number.isFinite(Number(post.downvoteCount)) ? Math.max(0, Math.trunc(Number(post.downvoteCount))) : 0;
    const commentCount = Number.isFinite(Number(post.commentCount)) ? Math.max(0, Math.trunc(Number(post.commentCount))) : 0;

    return {
        id: post.id,
        type: post.type || null,
        title: post.title || null,
        summary: post.summary || null,
        authorId: post.authorId || null,
        authorName: post.authorName || null,
        author: post.author
            ? {
                id: post.author.id || null,
                fullName: post.author.fullName || null,
            }
            : null,
        status: post.status || null,
        pinned: Boolean(post.pinned),
        expiresAt: post.expiresAt || null,
        createdAt: post.createdAt || null,
        updatedAt: post.updatedAt || null,
        tags: Array.isArray(post.tags)
            ? post.tags.map((tag) => ({
                id: tag.id,
                name: tag.name,
                slug: tag.slug,
            }))
            : [],
        refs: Array.isArray(post.refs)
            ? post.refs.map((ref) => ({
                service: ref.service,
                entityId: ref.entityId,
                metadata: ref.metadata || {},
                createdAt: ref.createdAt || null,
            }))
            : [],
        score,
        voteScore,
        upvoteCount,
        downvoteCount,
        commentCount,
        commentsCount: commentCount,
        userVote: post.userVote === 'up' || post.userVote === 'down' ? post.userVote : null,
    };
}

function buildSearchPostsSql({ hasCursor }) {
    const cursorFilter = hasCursor
        ? `
    AND (
        rank < $2
        OR (rank = $2 AND created_at < $3::timestamptz)
        OR (rank = $2 AND created_at = $3::timestamptz AND id < $4::uuid)
    )`
        : '';

    const limitPlaceholder = hasCursor ? '$5' : '$2';
    const postsTable = DB_TABLE_IDENTIFIERS.posts;
    const postTagsTable = DB_TABLE_IDENTIFIERS.postTags;
    const tagsTable = DB_TABLE_IDENTIFIERS.tags;

    return `
WITH search_input AS (
    SELECT websearch_to_tsquery('english', $1) AS query
),
ranked_posts AS (
    SELECT
        p.id,
        p.created_at,
        (
            ts_rank_cd(
                to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.summary, '')),
                si.query
            )
            + CASE WHEN COALESCE(tag_match.is_match, false) THEN 0.075 ELSE 0 END
        ) AS rank
    FROM ${postsTable} p
    CROSS JOIN search_input si
    LEFT JOIN LATERAL (
        SELECT true AS is_match
        FROM ${postTagsTable} pt
        INNER JOIN ${tagsTable} t ON t.id = pt.tag_id
        WHERE pt.post_id = p.id
            AND (
                t.name ILIKE '%' || $1 || '%'
                OR t.slug ILIKE '%' || $1 || '%'
                OR to_tsvector('english', coalesce(t.name, '') || ' ' || coalesce(t.slug, '')) @@ si.query
            )
        LIMIT 1
    ) AS tag_match ON true
    WHERE p.status = 'published'
        AND (
            to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.summary, '')) @@ si.query
            OR COALESCE(tag_match.is_match, false)
        )
)
SELECT id, created_at, rank
FROM ranked_posts
WHERE rank > 0${cursorFilter}
ORDER BY rank DESC, created_at DESC, id DESC
LIMIT ${limitPlaceholder};
`;
}

async function searchPosts({ q, limit, cursor = null, requestUserId = null }) {
    const hasCursor = Boolean(cursor);
    const sql = buildSearchPostsSql({ hasCursor });
    const queryParams = [q];

    if (hasCursor) {
        queryParams.push(cursor.rank);
        queryParams.push(cursor.createdAt);
        queryParams.push(cursor.id);
    }

    queryParams.push(limit + 1);

    const result = await searchQuery(sql, queryParams);
    const rankedRows = Array.isArray(result?.rows) ? result.rows : [];
    const pageRows = rankedRows.slice(0, limit);
    const postIds = pageRows.map((row) => String(row.id)).filter(Boolean);

    if (!postIds.length) {
        return {
            items: [],
            nextCursor: null,
        };
    }

    const postRows = await getPostsByIdsOrdered(postIds);
    const enrichedPosts = await enrichPosts(postRows, { requestUserId });
    const byId = new Map(enrichedPosts.map((post) => [String(post.id), post]));
    const items = postIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map(mapSearchResultItem);

    let nextCursor = null;
    if (rankedRows.length > limit && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1];
        const rank = Number(last.rank);
        if (Number.isFinite(rank) && last.created_at && last.id) {
            nextCursor = encodeSearchCursor({
                rank,
                createdAt: last.created_at,
                id: last.id,
            });
        }
    }

    return {
        items,
        nextCursor,
    };
}

async function getPostMetaById(postId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('id, status, author_id')
        .eq('id', postId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function getPostAuthorId(postId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('author_id')
        .eq('id', postId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data) return null;
    return data.author_id || null;
}

async function resolveTagFilterPostIds(tagFilter) {
    if (!tagFilter) return null;

    const isUuidLike = /^[0-9a-fA-F-]{32,36}$/.test(String(tagFilter));
    let tagRowsQuery = supabase
        .from(CONFIG.tables.tags)
        .select('id, slug');

    if (isUuidLike) {
        tagRowsQuery = tagRowsQuery.eq('id', tagFilter);
    } else {
        tagRowsQuery = tagRowsQuery.or(`slug.eq.${slugify(tagFilter)},name.ilike.%${sanitizeSearchTerm(tagFilter)}%`);
    }

    const { data: tags, error: tagsError } = await tagRowsQuery;
    if (tagsError) {
        throw tagsError;
    }

    const tagIds = (tags || []).map((tag) => tag.id);
    if (!tagIds.length) return [];

    const { data: links, error: linksError } = await supabase
        .from(CONFIG.tables.postTags)
        .select('post_id, tag_id')
        .in('tag_id', tagIds);

    if (linksError) {
        throw linksError;
    }

    return [...new Set((links || []).map((link) => link.post_id))];
}

app.get('/', (req, res) => {
    return res.json({
        health: 'Post service OK',
        supabaseConfigured: isSupabaseConfigured(),
        schema: CONFIG.schema,
        endpoints: [
            'GET /feed',
            'GET /search',
            'GET /posts/:id',
            'POST /posts',
            'PATCH /posts/:id',
            'DELETE /posts/:id',
            'POST /posts/:id/vote',
            'GET /posts/:id/comments',
            'POST /posts/:id/comments',
            'PATCH /posts/:id/comments/:commentId',
            'DELETE /posts/:id/comments/:commentId',
            'GET /tags',
            'POST /tags',
        ],
    });
});

app.get('/health', (req, res) => {
    return res.json({
        service: 'post-service',
        status: 'ok',
        supabaseConfigured: isSupabaseConfigured(),
        searchDbConfigured: isSearchDbConfigured(),
    });
});

app.post('/internal/archive-expired', ensureDb, async (req, res) => {
    try {
        const result = await archiveExpiredPosts();
        return res.json({ message: 'Archive sweep completed', ...result });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/feed', ensureDb, async (req, res) => {
    try {
        const requestUser = getRequestUser(req);
        const archiveResult = await archiveExpiredPosts().catch(() => ({ archivedCount: 0 }));
        const limit = parseIntInRange(req.query.limit, CONFIG.feedDefaultLimit, 1, CONFIG.feedMaxLimit);
        const offset = parseIntInRange(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const includeArchived = parseBool(req.query.includeArchived, false);
        const pinnedOnly = parseBool(req.query.pinnedOnly, false);
        const status = typeof req.query.status === 'string'
            ? req.query.status.trim().toLowerCase()
            : '';
        const type = req.query.type;
        const authorId = req.query.authorId || req.query.author_id;
        const tag = req.query.tag;
        const search = sanitizeSearchTerm(req.query.search || '');

        const tagFilteredPostIds = await resolveTagFilterPostIds(tag);
        if (Array.isArray(tagFilteredPostIds) && !tagFilteredPostIds.length) {
            return res.json({
                data: [],
                pagination: { limit, offset, total: 0 },
                meta: { archivedDuringRequest: archiveResult.archivedCount || 0 },
            });
        }

        let query = supabase
            .from(CONFIG.tables.posts)
            .select('*', { count: 'exact' })
            .order('pinned', { ascending: false })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (status && status !== 'all') {
            query = query.eq('status', status);
        } else if (!status && !includeArchived) {
            query = query.eq('status', 'published');
        } else if (status === 'all' && !includeArchived) {
            query = query.neq('status', 'archived');
        }

        if (pinnedOnly) {
            query = query.eq('pinned', true);
        }

        if (type) {
            query = query.eq('type', type);
        }

        if (authorId) {
            query = query.eq('author_id', authorId);
        }

        if (tagFilteredPostIds) {
            query = query.in('id', tagFilteredPostIds);
        }

        if (search) {
            query = query.or(`title.ilike.%${search}%,summary.ilike.%${search}%`);
        }

        const { data: rows, error, count } = await query;
        if (error) {
            throw error;
        }

        const data = await enrichPosts(rows || [], { requestUserId: requestUser?.id || null });

        return res.json({
            data,
            pagination: {
                limit,
                offset,
                total: count ?? data.length,
            },
            meta: {
                archivedDuringRequest: archiveResult.archivedCount || 0,
            },
        });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

async function handleSearchPosts(req, res) {
    try {
        const requestUser = getRequestUser(req);
        const payload = parseSearchRequest(req.query);

        if (payload.errors.length) {
            return res.status(400).json({
                error: 'Validation failed',
                details: payload.errors,
            });
        }

        const result = await searchPosts({
            q: payload.q,
            limit: payload.limit,
            cursor: payload.cursor,
            requestUserId: requestUser?.id || null,
        });

        return res.json(result);
    } catch (error) {
        if (error?.code === '42601' || /tsquery/i.test(String(error?.message || ''))) {
            return res.status(400).json({ error: 'Invalid search query' });
        }
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(error?.status || 500).json({
            error: error?.expose ? error.message : formatSupabaseError(error),
        });
    }
}

app.get(['/search', '/posts/search'], ensureDb, ensureSearchDb, handleSearchPosts);

app.get('/posts/:id', ensureDb, async (req, res) => {
    try {
        const requestUser = getRequestUser(req);
        const includeComments = parseBool(req.query.includeComments, false);
        const commentsLimit = parseIntInRange(req.query.commentsLimit, 50, 1, 200);
        const commentsOffset = parseIntInRange(req.query.commentsOffset, 0, 0, Number.MAX_SAFE_INTEGER);

        const post = await getPostById(req.params.id, { requestUserId: requestUser?.id || null });
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (includeComments) {
            const comments = await getCommentsForPost(req.params.id, {
                limit: commentsLimit,
                offset: commentsOffset,
            });
            return res.json({ data: { ...post, comments: comments.data }, commentPagination: comments.pagination });
        }

        return res.json({ data: post });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/posts', ensureDb, async (req, res) => {
    try {
        const payload = buildPostPayload(req.body);
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const normalizedType = String(payload.postFields.type || '').toUpperCase();
        if (normalizedType === 'ANNOUNCEMENT' || normalizedType === 'JOB') {
            const requestUser = getRequestUser(req);
            if (!requestUser?.id) {
                return res.status(401).json({
                    error: `Authentication is required to create ${normalizedType} posts.`,
                });
            }

            payload.postFields.author_id = requestUser.id;

            if (normalizedType === 'ANNOUNCEMENT' && !canCreateAnnouncement(requestUser.role)) {
                return res.status(403).json({
                    error: 'Only faculty/admin can create ANNOUNCEMENT posts.',
                });
            }
        }

        if (normalizedType === 'JOB') {
            const requestUser = getRequestUser(req);
            if (canCreateJobAsBypassRole(requestUser?.role)) {
                payload.postFields.author_id = requestUser.id;
            } else {
                if (!isAlumniRole(requestUser?.role)) {
                    return res.status(403).json({
                        error: 'Only verified alumni or faculty/admin can create JOB posts.',
                    });
                }

                const verificationStatus = await getAlumniVerificationStatus(requestUser.id).catch((error) => {
                    if (error?.code === '42P01') {
                        const err = new Error(`Missing table "${CONFIG.tables.alumniVerificationApplications}". Run services/user-service/schema.sql first.`);
                        err.status = 500;
                        throw err;
                    }
                    throw error;
                });

                if (verificationStatus !== 'approved') {
                    return res.status(403).json({
                        error: 'Only verified alumni or faculty/admin can create JOB posts.',
                    });
                }

                payload.postFields.author_id = requestUser.id;
            }
        }

        const { data: createdPost, error: createError } = await supabase
            .from(CONFIG.tables.posts)
            .insert(payload.postFields)
            .select('*')
            .single();

        if (createError) {
            throw createError;
        }

        if (payload.tagsProvided) {
            await replacePostTags(createdPost.id, payload.tagIds, payload.tagNames);
        }

        if (payload.refProvided) {
            await replacePostRef(createdPost.id, payload.ref);
        }

        const fullPost = await getPostById(createdPost.id);

        return res.status(201).json({
            message: 'Post created',
            data: fullPost || mapPost(createdPost),
        });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.patch('/posts/:id', ensureDb, async (req, res) => {
    try {
        const payload = buildPostPayload(req.body, { partial: true });
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const hasPostFields = Object.keys(payload.postFields).length > 0;
        const hasTagChanges = payload.tagsProvided;
        const hasRefChanges = payload.refProvided;
        const isExpiryUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'expires_at');
        const isStatusUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'status');
        const normalizedNextStatus = isStatusUpdate
            ? String(payload.postFields.status || '').trim().toLowerCase()
            : '';
        const isArchiveUpdate = isStatusUpdate && normalizedNextStatus === 'archived';

        if (!hasPostFields && !hasTagChanges && !hasRefChanges) {
            return res.status(400).json({
                error: 'No supported fields provided for update',
            });
        }

        if (isArchiveUpdate) {
            const requestUser = getRequestUser(req);
            if (!requestUser?.id) {
                return res.status(401).json({ error: 'Authentication is required to archive posts.' });
            }
            if (!isModeratorRole(requestUser.role)) {
                const authorId = await getPostAuthorId(req.params.id);
                if (authorId === null) {
                    return res.status(404).json({ error: 'Post not found' });
                }

                if (!authorId || String(authorId) !== String(requestUser.id)) {
                    return res.status(403).json({ error: 'Only faculty/admin or the original author can archive posts.' });
                }
            }
        }

        if (isExpiryUpdate) {
            const requestUser = getRequestUser(req);
            if (!requestUser?.id) {
                return res.status(401).json({ error: 'Authentication is required to update expiry.' });
            }

            if (!isModeratorRole(requestUser.role)) {
                const authorId = await getPostAuthorId(req.params.id);
                if (authorId === null) {
                    return res.status(404).json({ error: 'Post not found' });
                }

                if (!authorId || String(authorId) !== String(requestUser.id)) {
                    return res.status(403).json({
                        error: 'Only moderators and the original author can update expiry.',
                    });
                }
            }
        }

        if (hasPostFields) {
            const { data: updatedRows, error: updateError } = await supabase
                .from(CONFIG.tables.posts)
                .update(payload.postFields)
                .eq('id', req.params.id)
                .select('id');

            if (updateError) {
                throw updateError;
            }

            if (!updatedRows || updatedRows.length === 0) {
                return res.status(404).json({ error: 'Post not found' });
            }
        } else {
            const post = await getPostById(req.params.id);
            if (!post) {
                return res.status(404).json({ error: 'Post not found' });
            }
        }

        if (hasTagChanges) {
            await replacePostTags(req.params.id, payload.tagIds, payload.tagNames);
        }

        if (hasRefChanges) {
            await replacePostRef(req.params.id, payload.ref);
        }

        const fullPost = await getPostById(req.params.id);
        return res.json({
            message: 'Post updated',
            data: fullPost,
        });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.delete('/posts/:id', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const isOwner = String(postMeta.author_id || '') === String(req.requestUser.id || '');
        if (!isOwner && !isModeratorRole(req.requestUser.role)) {
            return res.status(403).json({ error: 'Only faculty/admin or the original author can delete this post.' });
        }

        const { data: deletedRows, error: deleteError } = await supabase
            .from(CONFIG.tables.posts)
            .delete()
            .eq('id', postId)
            .select('id');

        if (deleteError) {
            throw deleteError;
        }

        if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
            return res.status(404).json({ error: 'Post not found' });
        }

        return res.json({
            message: 'Post deleted',
            data: { id: postId },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/posts/:id/vote', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const voteInput = parseVoteInput(req.body?.vote ?? req.body?.direction ?? req.body?.value);
        if (voteInput.error) {
            return res.status(400).json({ error: voteInput.error });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (String(postMeta.status || '').toLowerCase() === 'archived') {
            return res.status(400).json({ error: 'Archived posts cannot be voted on.' });
        }

        if (voteInput.value === 0) {
            const { error: deleteError } = await supabase
                .from(CONFIG.tables.postVotes)
                .delete()
                .eq('post_id', postId)
                .eq('user_id', req.requestUser.id);

            if (deleteError) {
                if (isMissingTableError(deleteError)) return socialSchemaError(res);
                throw deleteError;
            }
        } else {
            const nowIso = new Date().toISOString();
            const { error: upsertError } = await supabase
                .from(CONFIG.tables.postVotes)
                .upsert({
                    post_id: postId,
                    user_id: req.requestUser.id,
                    vote: voteInput.value,
                    updated_at: nowIso,
                }, {
                    onConflict: 'post_id,user_id',
                });

            if (upsertError) {
                if (isMissingTableError(upsertError)) return socialSchemaError(res);
                throw upsertError;
            }
        }

        const post = await getPostById(postId, { requestUserId: req.requestUser.id });
        return res.json({
            message: voteInput.value === 0 ? 'Vote removed' : 'Vote updated',
            data: {
                postId,
                userVote: post?.userVote || null,
                score: post?.score || 0,
                voteScore: post?.voteScore || 0,
                upvoteCount: post?.upvoteCount || 0,
                downvoteCount: post?.downvoteCount || 0,
                commentCount: post?.commentCount || 0,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/posts/:id/comments', ensureDb, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const limit = parseIntInRange(req.query.limit, 50, 1, 200);
        const offset = parseIntInRange(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const comments = await getCommentsForPost(postId, { limit, offset });
        return res.json(comments);
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/posts/:id/comments', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const payload = parseCommentInput(req.body);
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (String(postMeta.status || '').toLowerCase() === 'archived') {
            return res.status(400).json({ error: 'Archived posts cannot be commented on.' });
        }

        const nowIso = new Date().toISOString();
        const { data: createdComment, error: insertError } = await supabase
            .from(CONFIG.tables.postComments)
            .insert({
                post_id: postId,
                author_id: req.requestUser.id,
                content: payload.content,
                updated_at: nowIso,
            })
            .select('*')
            .single();

        if (insertError) {
            if (isMissingTableError(insertError)) return socialSchemaError(res);
            throw insertError;
        }

        const userMap = await getUsersByIds([req.requestUser.id]);
        const post = await getPostById(postId, { requestUserId: req.requestUser.id });
        return res.status(201).json({
            message: 'Comment posted',
            data: mapComment(createdComment, userMap.get(req.requestUser.id) || null),
            meta: {
                commentCount: post?.commentCount || 0,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.patch('/posts/:id/comments/:commentId', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        const commentId = normalizeText(req.params.commentId);
        if (!postId || !commentId) {
            return res.status(400).json({ error: 'post id and comment id are required' });
        }

        const payload = parseCommentInput(req.body);
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const existingComment = await getPostCommentById(postId, commentId);
        if (!existingComment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const isOwner = String(existingComment.author_id) === String(req.requestUser.id);
        if (!isOwner && !isModeratorRole(req.requestUser.role)) {
            return res.status(403).json({ error: 'You can only edit your own comment.' });
        }

        const nowIso = new Date().toISOString();
        const { data: updatedComment, error: updateError } = await supabase
            .from(CONFIG.tables.postComments)
            .update({
                content: payload.content,
                updated_at: nowIso,
            })
            .eq('id', commentId)
            .eq('post_id', postId)
            .select('*')
            .single();

        if (updateError) {
            if (isMissingTableError(updateError)) return socialSchemaError(res);
            throw updateError;
        }

        const userMap = await getUsersByIds([updatedComment.author_id]);
        return res.json({
            message: 'Comment updated',
            data: mapComment(updatedComment, userMap.get(updatedComment.author_id) || null),
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.delete('/posts/:id/comments/:commentId', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        const commentId = normalizeText(req.params.commentId);
        if (!postId || !commentId) {
            return res.status(400).json({ error: 'post id and comment id are required' });
        }

        const existingComment = await getPostCommentById(postId, commentId);
        if (!existingComment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const isOwner = String(existingComment.author_id) === String(req.requestUser.id);
        if (!isOwner && !isModeratorRole(req.requestUser.role)) {
            return res.status(403).json({ error: 'You can only delete your own comment.' });
        }

        const { error: deleteError } = await supabase
            .from(CONFIG.tables.postComments)
            .delete()
            .eq('id', commentId)
            .eq('post_id', postId);

        if (deleteError) {
            if (isMissingTableError(deleteError)) return socialSchemaError(res);
            throw deleteError;
        }

        const post = await getPostById(postId, { requestUserId: req.requestUser.id });
        return res.json({
            message: 'Comment deleted',
            data: {
                id: commentId,
                postId,
            },
            meta: {
                commentCount: post?.commentCount || 0,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/tags', ensureDb, async (req, res) => {
    try {
        const limit = parseIntInRange(req.query.limit, 100, 1, 500);
        const q = sanitizeSearchTerm(req.query.q || '');

        let query = supabase
            .from(CONFIG.tables.tags)
            .select('id, name, slug, created_at')
            .order('name', { ascending: true })
            .limit(limit);

        if (q) {
            query = query.or(`name.ilike.%${q}%,slug.ilike.%${q}%`);
        }

        const { data, error } = await query;
        if (error) {
            throw error;
        }

        return res.json({
            data: (data || []).map(mapTag),
        });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/tags', ensureDb, async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const slugInput = typeof req.body.slug === 'string' ? req.body.slug.trim() : '';

        if (!name) {
            return res.status(400).json({ error: 'name is required' });
        }

        const slug = slugInput || slugify(name);
        if (!slug) {
            return res.status(400).json({ error: 'Could not generate a valid slug' });
        }

        const { data, error } = await supabase
            .from(CONFIG.tables.tags)
            .upsert({ name, slug }, { onConflict: 'slug' })
            .select('id, name, slug, created_at')
            .single();

        if (error) {
            throw error;
        }

        return res.status(201).json({
            message: 'Tag created',
            data: mapTag(data),
        });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.use((req, res) => {
    return res.status(404).json({ error: 'Route not found' });
});

const server = app.listen(PORT, () => {
    console.log(`Post Service is running on port ${PORT}`);
    if (!isSupabaseConfigured()) {
        console.log('Post Service started without Supabase config. DB routes will return 503.');
    }
    if (!isSearchDbConfigured()) {
        console.log('Post Service started without SUPABASE_DB_URL. Search route will return 503.');
    }
});

server.on('close', () => {
    closeSearchDbPool().catch((error) => {
        console.error('Post search pool shutdown failed:', error.message);
    });
});

let archiveTimer = null;
if (CONFIG.archiveIntervalMs > 0 && isSupabaseConfigured()) {
    archiveTimer = setInterval(async () => {
        try {
            const result = await archiveExpiredPosts();
            if (result.archivedCount > 0) {
                console.log(`Archived ${result.archivedCount} expired posts`);
            }
        } catch (error) {
            console.error('Post archive sweep failed:', formatSupabaseError(error));
        }
    }, CONFIG.archiveIntervalMs);

    if (typeof archiveTimer.unref === 'function') {
        archiveTimer.unref();
    }
}

module.exports = { app, server, supabase, CONFIG };
