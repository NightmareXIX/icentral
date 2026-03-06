import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
const PAGE_SIZE = 30;

function normalizeConversations(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      conversationId: item.conversationId,
      otherUserId: item.otherUserId || 'Unknown user',
      otherUserEmail: item.otherUserEmail || null,
      lastMessage: item.lastMessage || null,
      lastMessageAt: item.lastMessageAt || null,
      unreadCount: Number(item.unreadCount || 0),
    }))
    .filter((item) => item.conversationId)
    .sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });
}

function upsertConversation(list, update) {
  if (!update?.conversationId) return list;

  const normalized = {
    conversationId: update.conversationId,
    otherUserId: update.otherUserId || 'Unknown user',
    otherUserEmail: update.otherUserEmail || null,
    lastMessage: update.lastMessage || null,
    lastMessageAt: update.lastMessageAt || null,
    unreadCount: Number(update.unreadCount || 0),
  };

  const others = list.filter((item) => item.conversationId !== normalized.conversationId);
  return normalizeConversations([normalized, ...others]);
}

function mergeMessages(baseItems, nextItems, mode = 'append') {
  const combined = mode === 'prepend'
    ? [...nextItems, ...baseItems]
    : [...baseItems, ...nextItems];

  const seen = new Set();
  const deduped = [];

  for (const item of combined) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  return deduped.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function formatConversationTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const sameDay =
    now.getFullYear() === date.getFullYear()
    && now.getMonth() === date.getMonth()
    && now.getDate() === date.getDate();

  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function formatMessageTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function getAvatarLabel(text) {
  const raw = String(text || '').trim();
  if (!raw) return '?';

  const source = raw.includes('@') ? raw.split('@')[0] : raw;
  const parts = source.split(/[\s._-]+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
  }

  return source.slice(0, 2).toUpperCase();
}

async function chatRequest(token, path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

async function loadSocketIoFactory(baseUrl) {
  if (typeof window === 'undefined') {
    throw new Error('Socket client can only be used in a browser');
  }

  if (typeof window.io === 'function') {
    return window.io;
  }

  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-socket-io-client="true"]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load socket client')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = `${baseUrl}/chat/socket.io/socket.io.js`;
    script.async = true;
    script.dataset.socketIoClient = 'true';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load socket client'));
    document.body.appendChild(script);
  });

  if (typeof window.io !== 'function') {
    throw new Error('Socket client did not initialize');
  }

  return window.io;
}

export default function ChatPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, user, isAuthenticated } = useAuth();

  const socketRef = useRef(null);
  const selectedConversationRef = useRef(null);
  const messagesViewportRef = useRef(null);

  const [conversations, setConversations] = useState([]);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [conversationsError, setConversationsError] = useState('');

  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [messages, setMessages] = useState([]);
  const [messagesError, setMessagesError] = useState('');
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);

  const [draftBody, setDraftBody] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);

  const [emailQuery, setEmailQuery] = useState('');
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [userSearchResults, setUserSearchResults] = useState([]);
  const [selectedRecipient, setSelectedRecipient] = useState(null);

  const [chatListQuery, setChatListQuery] = useState('');
  const [conversationFilter, setConversationFilter] = useState('all');

  const [startingConversation, setStartingConversation] = useState(false);
  const [startConversationError, setStartConversationError] = useState('');

  const [socketConnected, setSocketConnected] = useState(false);

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.conversationId === selectedConversationId) || null,
    [conversations, selectedConversationId],
  );

  const currentUserId = String(user?.id || '');

  const visibleConversations = useMemo(() => {
    const query = chatListQuery.trim().toLowerCase();

    return conversations.filter((item) => {
      if (conversationFilter === 'unread' && item.unreadCount <= 0) {
        return false;
      }

      if (!query) return true;

      const haystacks = [
        item.otherUserEmail,
        item.otherUserId,
        item.lastMessage,
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());

      return haystacks.some((value) => value.includes(query));
    });
  }, [chatListQuery, conversationFilter, conversations]);

  const unreadConversationCount = useMemo(
    () => conversations.filter((item) => item.unreadCount > 0).length,
    [conversations],
  );

  const selectedConversationName = selectedConversation
    ? (selectedConversation.otherUserEmail || selectedConversation.otherUserId)
    : '';

  const scrollMessagesToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (!messagesViewportRef.current) return;
      messagesViewportRef.current.scrollTop = messagesViewportRef.current.scrollHeight;
    });
  }, []);

  const markConversationRead = useCallback(async (conversationId) => {
    if (!conversationId || !token) return;

    try {
      await chatRequest(token, `/chat/conversations/${conversationId}/read`, {
        method: 'POST',
      });
    } catch (error) {
      console.warn('Failed to mark conversation as read', error);
    }
  }, [token]);

  const loadConversations = useCallback(async (preferredConversationId = null) => {
    if (!token) return;

    setLoadingConversations(true);
    setConversationsError('');

    try {
      const result = await chatRequest(token, '/chat/conversations');
      const items = normalizeConversations(result?.items || result);
      setConversations(items);

      if (preferredConversationId) {
        setSelectedConversationId(preferredConversationId);
      } else if (!selectedConversationRef.current && items.length > 0) {
        setSelectedConversationId(items[0].conversationId);
      } else if (selectedConversationRef.current && !items.some((item) => item.conversationId === selectedConversationRef.current)) {
        setSelectedConversationId(items[0]?.conversationId || '');
      }
    } catch (error) {
      setConversationsError(error.message || 'Could not load conversations');
    } finally {
      setLoadingConversations(false);
    }
  }, [token]);

  const loadMessages = useCallback(async ({ conversationId, cursor = null, mode = 'replace' }) => {
    if (!token || !conversationId) return;

    if (mode === 'prepend') {
      setLoadingOlder(true);
    } else {
      setLoadingMessages(true);
      setMessagesError('');
    }

    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      if (cursor) params.set('cursor', cursor);

      const result = await chatRequest(token, `/chat/conversations/${conversationId}/messages?${params.toString()}`);
      const incomingItems = Array.isArray(result?.items) ? result.items : [];

      if (mode === 'replace' && selectedConversationRef.current !== conversationId) {
        return;
      }

      setNextCursor(result?.nextCursor || null);

      if (mode === 'prepend') {
        setMessages((prev) => mergeMessages(prev, incomingItems, 'prepend'));
      } else {
        setMessages(incomingItems);
        await markConversationRead(conversationId);
        scrollMessagesToBottom();
      }
    } catch (error) {
      setMessagesError(error.message || 'Could not load messages');
    } finally {
      setLoadingMessages(false);
      setLoadingOlder(false);
    }
  }, [markConversationRead, scrollMessagesToBottom, token]);

  useEffect(() => {
    if (!isAuthenticated || !token) {
      navigate('/login');
      return;
    }

    const preferredConversationId = location.state?.preferredConversationId
      ? String(location.state.preferredConversationId)
      : null;

    loadConversations(preferredConversationId);
  }, [isAuthenticated, loadConversations, location.state, navigate, token]);

  useEffect(() => {
    selectedConversationRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      setNextCursor(null);
      return;
    }

    loadMessages({ conversationId: selectedConversationId, mode: 'replace' });
  }, [loadMessages, selectedConversationId]);

  useEffect(() => {
    if (!token || !isAuthenticated) return undefined;
    let isCancelled = false;
    let activeSocket = null;

    async function connectSocket() {
      try {
        const ioFactory = await loadSocketIoFactory(API_BASE_URL);
        if (isCancelled) return;

        const socket = ioFactory(API_BASE_URL, {
          path: '/chat/socket.io',
          transports: ['websocket', 'polling'],
          auth: { token },
        });

        activeSocket = socket;
        socketRef.current = socket;

        socket.on('connect', () => {
          setSocketConnected(true);
          if (selectedConversationRef.current) {
            socket.emit('conversation:join', { conversationId: selectedConversationRef.current });
          }
        });

        socket.on('disconnect', () => {
          setSocketConnected(false);
        });

        socket.on('conversation:updated', (payload) => {
          if (!payload?.conversationId) return;
          setConversations((prev) => upsertConversation(prev, payload));
        });

        socket.on('message:new', async (message) => {
          if (!message?.conversationId) return;
          if (message.conversationId !== selectedConversationRef.current) return;

          setMessages((prev) => mergeMessages(prev, [message], 'append'));

          if (String(message.senderId) !== currentUserId) {
            await markConversationRead(message.conversationId);
          }

          scrollMessagesToBottom();
        });

        socket.on('connect_error', (error) => {
          console.warn('Socket connection failed', error?.message || error);
        });
      } catch (error) {
        if (!isCancelled) {
          console.warn('Could not initialize socket client', error?.message || error);
        }
      }
    }

    connectSocket();

    return () => {
      isCancelled = true;
      if (activeSocket) {
        activeSocket.disconnect();
      }
      socketRef.current = null;
      setSocketConnected(false);
    };
  }, [currentUserId, isAuthenticated, markConversationRead, scrollMessagesToBottom, token]);

  useEffect(() => {
    if (!selectedConversationId || !socketRef.current || !socketConnected) return;

    socketRef.current.emit('conversation:join', { conversationId: selectedConversationId });
  }, [selectedConversationId, socketConnected]);

  useEffect(() => {
    if (!token) return undefined;

    const normalizedQuery = emailQuery.trim();

    if (selectedRecipient && selectedRecipient.email !== normalizedQuery) {
      setSelectedRecipient(null);
    }

    if (normalizedQuery.length < 2) {
      setUserSearchResults([]);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        setSearchingUsers(true);
        const params = new URLSearchParams({ query: normalizedQuery });
        const result = await chatRequest(token, `/chat/users/search?${params.toString()}`, {
          signal: controller.signal,
        });
        setUserSearchResults(Array.isArray(result?.items) ? result.items : []);
      } catch (error) {
        if (error.name !== 'AbortError') {
          setUserSearchResults([]);
        }
      } finally {
        setSearchingUsers(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [emailQuery, selectedRecipient, token]);

  async function handleStartConversation(event) {
    event.preventDefault();

    const trimmedEmail = emailQuery.trim();
    if (!trimmedEmail || !token) return;

    setStartingConversation(true);
    setStartConversationError('');

    try {
      const payload = selectedRecipient?.id
        ? { otherUserId: selectedRecipient.id }
        : { otherUserEmail: trimmedEmail };

      const result = await chatRequest(token, '/chat/conversations/dm', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const conversationId = result?.conversationId;
      if (!conversationId) {
        throw new Error('Conversation was not created');
      }

      setEmailQuery('');
      setUserSearchResults([]);
      setSelectedRecipient(null);
      await loadConversations(conversationId);
      setSelectedConversationId(conversationId);
    } catch (error) {
      setStartConversationError(error.message || 'Could not start conversation');
    } finally {
      setStartingConversation(false);
    }
  }

  async function handleSendMessage(event) {
    event.preventDefault();

    if (!token || !selectedConversationId || sendingMessage) return;

    const trimmedBody = draftBody.trim();
    if (!trimmedBody) return;

    setSendingMessage(true);
    setMessagesError('');

    try {
      const createdMessage = await chatRequest(token, `/chat/conversations/${selectedConversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: trimmedBody }),
      });

      setDraftBody('');
      setMessages((prev) => mergeMessages(prev, [createdMessage], 'append'));
      setConversations((prev) => upsertConversation(prev, {
        conversationId: selectedConversationId,
        otherUserId: selectedConversation?.otherUserId,
        otherUserEmail: selectedConversation?.otherUserEmail,
        lastMessage: createdMessage.body,
        lastMessageAt: createdMessage.createdAt,
        unreadCount: 0,
      }));
      scrollMessagesToBottom();
    } catch (error) {
      setMessagesError(error.message || 'Could not send message');
    } finally {
      setSendingMessage(false);
    }
  }

  async function handleLoadOlderMessages() {
    if (!selectedConversationId || !nextCursor || loadingOlder) return;

    await loadMessages({
      conversationId: selectedConversationId,
      cursor: nextCursor,
      mode: 'prepend',
    });
  }

  return (
    <div className="chat-page">
      <div className="chat-layout">
        <aside className="chat-sidebar" aria-label="Conversations">
          <header className="chat-sidebar-top">
            <h2>Chats</h2>
            <div className="chat-sidebar-actions">
              <button type="button" className="chat-icon-btn" aria-label="Options">
                <span>...</span>
              </button>
              <button type="button" className="chat-icon-btn" aria-label="New message">
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path d="M4 17.25V20h2.75L17.8 8.94l-2.75-2.75L4 17.25zm16.71-9.04a1 1 0 0 0 0-1.41l-1.5-1.5a1 1 0 0 0-1.41 0l-1.17 1.17l2.75 2.75l1.33-1.01z" />
                </svg>
              </button>
            </div>
          </header>

          <label className="chat-list-search" htmlFor="chat-list-search-input">
            <span aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M10 3a7 7 0 1 1 0 14a7 7 0 0 1 0-14zm0 2a5 5 0 1 0 .001 10.001A5 5 0 0 0 10 5zm8.707 11.293l2 2a1 1 0 0 1-1.414 1.414l-2-2a1 1 0 0 1 1.414-1.414z" />
              </svg>
            </span>
            <input
              id="chat-list-search-input"
              type="search"
              placeholder="Search chats"
              value={chatListQuery}
              onChange={(event) => setChatListQuery(event.target.value)}
            />
          </label>

          <div className="chat-filter-tabs" role="tablist" aria-label="Conversation filters">
            <button
              type="button"
              className={`chat-filter-tab${conversationFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => setConversationFilter('all')}
            >
              All
            </button>
            <button
              type="button"
              className={`chat-filter-tab${conversationFilter === 'unread' ? ' is-active' : ''}`}
              onClick={() => setConversationFilter('unread')}
            >
              Unread
              {unreadConversationCount > 0 ? <span>{unreadConversationCount}</span> : null}
            </button>
          </div>

          <form className="chat-start-form" onSubmit={handleStartConversation}>
            <label htmlFor="chat-user-email">Start new chat by email</label>
            <div className="chat-start-row">
              <input
                id="chat-user-email"
                type="email"
                placeholder="user@example.com"
                value={emailQuery}
                onChange={(event) => setEmailQuery(event.target.value)}
              />
              <button className="btn btn-accent" type="submit" disabled={startingConversation || !emailQuery.trim()}>
                {startingConversation ? 'Starting...' : 'Start'}
              </button>
            </div>
            {searchingUsers ? <p className="chat-empty-text">Searching users...</p> : null}
            {userSearchResults.length > 0 ? (
              <div className="chat-search-list">
                {userSearchResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`chat-search-item${selectedRecipient?.id === item.id ? ' is-selected' : ''}`}
                    onClick={() => {
                      setSelectedRecipient(item);
                      setEmailQuery(item.email || '');
                    }}
                  >
                    <strong>{item.email}</strong>
                    <small>{item.fullName || item.id}</small>
                  </button>
                ))}
              </div>
            ) : null}
            {startConversationError ? <p className="chat-inline-error">{startConversationError}</p> : null}
          </form>

          <div className="chat-conversation-list">
            {loadingConversations ? (
              <p className="chat-empty-text">Loading conversations...</p>
            ) : conversationsError ? (
              <p className="chat-inline-error">{conversationsError}</p>
            ) : visibleConversations.length === 0 ? (
              <p className="chat-empty-text">No conversations found.</p>
            ) : (
              visibleConversations.map((conversation) => {
                const displayName = conversation.otherUserEmail || conversation.otherUserId;
                return (
                  <button
                    key={conversation.conversationId}
                    type="button"
                    className={`chat-conversation-item${selectedConversationId === conversation.conversationId ? ' is-active' : ''}`}
                    onClick={() => setSelectedConversationId(conversation.conversationId)}
                  >
                    <span className="chat-conversation-avatar" aria-hidden="true">{getAvatarLabel(displayName)}</span>
                    <div className="chat-conversation-main">
                      <div className="chat-conversation-head">
                        <strong>{displayName}</strong>
                        <small>{formatConversationTime(conversation.lastMessageAt)}</small>
                      </div>
                      <div className="chat-conversation-foot">
                        <p>{conversation.lastMessage || 'No messages yet'}</p>
                        {conversation.unreadCount > 0 ? (
                          <span className="chat-unread-badge">{conversation.unreadCount}</span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="chat-thread-panel" aria-label="Messages">
          {selectedConversation ? (
            <>
              <header className="chat-thread-header">
                <div className="chat-thread-identity">
                  <span className="chat-thread-avatar" aria-hidden="true">{getAvatarLabel(selectedConversationName)}</span>
                  <div>
                    <h3>{selectedConversationName}</h3>
                    <small>{socketConnected ? 'Active now' : 'Reconnecting...'}</small>
                  </div>
                </div>
                <div className="chat-thread-actions">
                  <button type="button" className="chat-icon-btn" aria-label="Call">
                    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                      <path d="M6.6 10.79a15.05 15.05 0 0 0 6.61 6.61l2.2-2.2a1 1 0 0 1 1.03-.24c1.12.37 2.31.57 3.56.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.61 21 3 13.39 3 4a1 1 0 0 1 1-1h3.47a1 1 0 0 1 1 1c0 1.25.2 2.44.57 3.56a1 1 0 0 1-.24 1.03l-2.2 2.2z" />
                    </svg>
                  </button>
                  <button type="button" className="chat-icon-btn" aria-label="Video call">
                    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                      <path d="M3 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1.38l4.45-2.58A1 1 0 0 1 21 6.66v10.68a1 1 0 0 1-1.55.86L15 15.62V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                    </svg>
                  </button>
                  <button type="button" className="chat-icon-btn" aria-label="Conversation info">
                    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                      <path d="M11 10h2v7h-2v-7zm0-3h2v2h-2V7zm1-5a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2z" />
                    </svg>
                  </button>
                </div>
              </header>

              <div className="chat-messages-viewport" ref={messagesViewportRef}>
                {nextCursor ? (
                  <div className="chat-load-older-wrap">
                    <button
                      type="button"
                      className="btn btn-soft"
                      onClick={handleLoadOlderMessages}
                      disabled={loadingOlder}
                    >
                      {loadingOlder ? 'Loading...' : 'Load older messages'}
                    </button>
                  </div>
                ) : null}

                {loadingMessages ? (
                  <p className="chat-empty-text">Loading messages...</p>
                ) : messages.length === 0 ? (
                  <p className="chat-empty-text">No messages yet. Say hello.</p>
                ) : (
                  <div className="chat-message-list">
                    {messages.map((message) => {
                      const isOwn = String(message.senderId) === currentUserId;
                      return (
                        <article key={message.id} className={`chat-message-row${isOwn ? ' is-own' : ''}`}>
                          {!isOwn ? (
                            <span className="chat-message-avatar" aria-hidden="true">
                              {getAvatarLabel(selectedConversationName)}
                            </span>
                          ) : null}
                          <div className={`chat-message-bubble${isOwn ? ' is-own' : ''}`}>
                            <p>{message.body}</p>
                            <small>{formatMessageTime(message.createdAt)}</small>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>

              <form className="chat-compose-form" onSubmit={handleSendMessage}>
                <div className="chat-compose-tools" aria-hidden="true">
                  <button type="button" className="chat-icon-btn">+</button>
                  <button type="button" className="chat-icon-btn">GIF</button>
                </div>
                <input
                  type="text"
                  placeholder="Type a message..."
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  maxLength={2000}
                />
                <button type="submit" className="btn btn-primary-solid chat-send-btn" disabled={sendingMessage || !draftBody.trim()}>
                  {sendingMessage ? '...' : 'Send'}
                </button>
              </form>
            </>
          ) : (
            <div className="chat-empty-state">
              <h3>Select a conversation</h3>
              <p>Pick one from the left or start a new chat by email.</p>
            </div>
          )}

          {messagesError ? <p className="chat-inline-error chat-thread-error">{messagesError}</p> : null}
        </section>
      </div>
    </div>
  );
}
