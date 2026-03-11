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
import PostDetailsPage from './pages/PostDetailsPage';
import SearchPage from './pages/SearchPage';
import DashboardPage from './pages/DashboardPage';
import ProfilePage from './pages/ProfilePage';
import CollabPage from './pages/CollabPage';
import CollabDetailsPage from './pages/CollabDetailsPage';
import EventsPage from './pages/EventsPage';
import NewsletterPage from './pages/NewsletterPage';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />

        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomeFeedPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/posts/:postId" element={<PostDetailsPage />} />
          <Route path="/job-portal" element={<JobPortalPage />} />
          <Route path="/job-portal/:postId/apply" element={<JobApplicationPage />} />
          <Route path="/job-portal/:postId/applications" element={<JobApplicationsPage />} />
          <Route path="/alumni-verification" element={<AlumniVerificationPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/profile/:userId" element={<ProfilePage />} />
          <Route path="/collaborate" element={<CollabPage />} />
          <Route path="/collaborate/:collabId" element={<CollabDetailsPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route
            path="/moderation"
            element={
              <RequireModerator>
                <ModerationPage />
              </RequireModerator>
            }
          />
          <Route
            path="/moderation/newsletter"
            element={
              <RequireModerator>
                <NewsletterPage />
              </RequireModerator>
            }
          />
          <Route
            path="/newsletter"
            element={<Navigate to="/moderation/newsletter" replace />}
          />
        </Route>

        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
