import { Link } from 'react-router-dom';
import NewsletterWorkspace from '../components/moderation/NewsletterWorkspace';

export default function NewsletterPage() {
  return (
    <div className="moderation-page newsletter-management-page">
      <div className="newsletter-page-nav">
        <Link className="newsletter-page-backlink" to="/moderation">
          <span aria-hidden="true">←</span>
          <span>Moderation</span>
        </Link>
      </div>

      <NewsletterWorkspace />
    </div>
  );
}
