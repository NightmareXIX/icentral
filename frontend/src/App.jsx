import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
import AppShell from './components/layout/AppShell';
import RequireModerator from './components/routing/RequireModerator';
import Login from './components/Login';
import Signup from './components/Signup';
import HomeFeedPage from './pages/HomeFeedPage';
import JobPortalPage from './pages/JobPortalPage';
import JobApplicationPage from './pages/JobApplicationPage';
import JobApplicationsPage from './pages/JobApplicationsPage';
import AlumniVerificationPage from './pages/AlumniVerificationPage';
import ModerationPage from './pages/ModerationPage';
import NotificationsPage from './pages/NotificationsPage';
import ChatPage from './pages/ChatPage';
import SectionPlaceholderPage from './pages/SectionPlaceholderPage';
import PostDetailsPage from './pages/PostDetailsPage';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />

        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomeFeedPage />} />
          <Route path="/posts/:postId" element={<PostDetailsPage />} />
          <Route path="/job-portal" element={<JobPortalPage />} />
          <Route path="/job-portal/:postId/apply" element={<JobApplicationPage />} />
          <Route path="/job-portal/:postId/applications" element={<JobApplicationsPage />} />
          <Route path="/alumni-verification" element={<AlumniVerificationPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route
            path="/events"
            element={
              <SectionPlaceholderPage
                title="Events"
                subtitle="This section will display event posts and event recaps in a dedicated feed view."
                notes={[
                  { title: 'Planned behavior', body: 'Event-tag and EVENT/EVENT_RECAP posts with RSVP-focused cards later.' },
                  { title: 'Collaboration link', body: 'Collaborate posts related to events will also surface here as requested.' },
                ]}
              />
            }
          />
          <Route
            path="/collaborate"
            element={
              <SectionPlaceholderPage
                title="Collaborate"
                subtitle="This section is prepared for collaboration/event invitation posts. We will build the posting workflow next."
                notes={[
                  { title: 'Post type page', body: 'Users will create collaboration invitations tied to event/research/community activities.' },
                  { title: 'Cross-surface visibility', body: 'These collaboration posts will also appear in the Events section.' },
                ]}
              />
            }
          />
          <Route
            path="/moderation"
            element={
              <RequireModerator>
                <ModerationPage />
              </RequireModerator>
            }
          />
          <Route
            path="/newsletter"
            element={
              <SectionPlaceholderPage
                title="Newsletter"
                subtitle="Newsletter curation and export workflows will live here. The shell and navigation are ready."
                notes={[
                  { title: 'Planned flow', body: 'Curate posts from the feed into newsletter collections and export formatted output.' },
                  { title: 'Integration', body: 'Will pull selected feed items and later support approval/export tracking.' },
                ]}
              />
            }
          />
          <Route path="/dashboard" element={<Navigate to="/home" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
