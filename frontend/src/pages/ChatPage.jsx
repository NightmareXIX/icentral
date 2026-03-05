import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
const PAGE_SIZE = 30;

function normalizeConversations(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      conversationId: item.conversationId,
      otherUserId: item.otherUserId || 'Unknown user',
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

export default function ChatPage() {
  const navigate = useNavigate();
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

  const [startUserId, setStartUserId] = useState('');
  const [startingConversation, setStartingConversation] = useState(false);
  const [startConversationError, setStartConversationError] = useState('');

  const [socketConnected, setSocketConnected] = useState(false);

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.conversationId === selectedConversationId) || null,
    [conversations, selectedConversationId],
  );

  const currentUserId = String(user?.id || '');

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

    loadConversations();
  }, [isAuthenticated, loadConversations, navigate, token]);

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

    const socket = io(API_BASE_URL, {
      path: '/chat/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token },
    });

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

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setSocketConnected(false);
    };
  }, [currentUserId, isAuthenticated, markConversationRead, scrollMessagesToBottom, token]);

  useEffect(() => {
    if (!selectedConversationId || !socketRef.current || !socketConnected) return;

    socketRef.current.emit('conversation:join', { conversationId: selectedConversationId });
  }, [selectedConversationId, socketConnected]);

  async function handleStartConversation(event) {
    event.preventDefault();

    const trimmedUserId = startUserId.trim();
    if (!trimmedUserId || !token) return;

    setStartingConversation(true);
    setStartConversationError('');

    try {
      const result = await chatRequest(token, '/chat/conversations/dm', {
        method: 'POST',
        body: JSON.stringify({ otherUserId: trimmedUserId }),
      });

      const conversationId = result?.conversationId;
      if (!conversationId) {
        throw new Error('Conversation was not created');
      }

      setStartUserId('');
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
    <div className="chat-page panel">
      <div className="chat-page-header">
        <div>
          <p className="eyebrow">Messaging</p>
          <h2>Direct Messages</h2>
        </div>
        <span className={`chat-connection-pill${socketConnected ? ' is-online' : ''}`}>
          {socketConnected ? 'Realtime connected' : 'Realtime reconnecting'}
        </span>
      </div>

      <div className="chat-layout">
        <aside className="chat-sidebar" aria-label="Conversations">
          <form className="chat-start-form" onSubmit={handleStartConversation}>
            <label htmlFor="chat-user-id">Start new chat</label>
            <div className="chat-start-row">
              <input
                id="chat-user-id"
                type="text"
                placeholder="Enter user ID"
                value={startUserId}
                onChange={(event) => setStartUserId(event.target.value)}
              />
              <button className="btn btn-accent" type="submit" disabled={startingConversation || !startUserId.trim()}>
                {startingConversation ? 'Starting...' : 'Start'}
              </button>
            </div>
            {startConversationError ? <p className="chat-inline-error">{startConversationError}</p> : null}
          </form>

          <div className="chat-conversation-list">
            {loadingConversations ? (
              <p className="chat-empty-text">Loading conversations...</p>
            ) : conversationsError ? (
              <p className="chat-inline-error">{conversationsError}</p>
            ) : conversations.length === 0 ? (
              <p className="chat-empty-text">No conversations yet. Start one using a user ID.</p>
            ) : (
              conversations.map((conversation) => (
                <button
                  key={conversation.conversationId}
                  type="button"
                  className={`chat-conversation-item${selectedConversationId === conversation.conversationId ? ' is-active' : ''}`}
                  onClick={() => setSelectedConversationId(conversation.conversationId)}
                >
                  <div className="chat-conversation-head">
                    <strong>{conversation.otherUserId}</strong>
                    <small>{formatConversationTime(conversation.lastMessageAt)}</small>
                  </div>
                  <div className="chat-conversation-foot">
                    <p>{conversation.lastMessage || 'No messages yet'}</p>
                    {conversation.unreadCount > 0 ? (
                      <span className="chat-unread-badge">{conversation.unreadCount}</span>
                    ) : null}
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="chat-thread-panel" aria-label="Messages">
          {selectedConversation ? (
            <>
              <header className="chat-thread-header">
                <div>
                  <p className="eyebrow">Conversation</p>
                  <h3>{selectedConversation.otherUserId}</h3>
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
                <input
                  type="text"
                  placeholder="Type a message..."
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  maxLength={2000}
                />
                <button type="submit" className="btn btn-primary-solid" disabled={sendingMessage || !draftBody.trim()}>
                  {sendingMessage ? 'Sending...' : 'Send'}
                </button>
              </form>
            </>
          ) : (
            <div className="chat-empty-state">
              <h3>Select a conversation</h3>
              <p>Choose a conversation from the left, or start a new DM using a user ID.</p>
            </div>
          )}

          {messagesError ? <p className="chat-inline-error chat-thread-error">{messagesError}</p> : null}
        </section>
      </div>
    </div>
  );
}
