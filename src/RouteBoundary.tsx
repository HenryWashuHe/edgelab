import { Component, Suspense, type ReactNode } from 'react';

export class RouteBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed)
      return (
        <section className="route-state" role="alert" aria-label="Section unavailable">
          <h2>This section is unavailable.</h2>
          <p>You can choose another section or reload the page.</p>
          <p>
            Reloading clears operator access, unsaved drafts, and recordings held in this page.
            Requests already sent may have completed; reloading does not replay them.
          </p>
          <button className="button" type="button" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </section>
      );

    return (
      <Suspense
        fallback={
          <div className="route-state" role="status" aria-live="polite">
            Loading {this.props.label}…
          </div>
        }
      >
        {this.props.children}
      </Suspense>
    );
  }
}
