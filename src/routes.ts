export type AppPage =
  'operations' | 'playground' | 'observer' | 'replay' | 'architecture' | 'notes';

export function parsePageHash(hash: string): AppPage {
  switch (hash) {
    case '#playground':
      return 'playground';
    case '#observer':
      return 'observer';
    case '#replay':
      return 'replay';
    case '#architecture':
      return 'architecture';
    case '#notes':
      return 'notes';
    default:
      return 'operations';
  }
}

export function navigateToPage(
  page: AppPage,
  target: { hash: string },
  selectPage: (page: AppPage) => void,
) {
  target.hash = `#${page}`;
  selectPage(page);
}

export const pageLabels: Record<AppPage, string> = {
  operations: 'Operations',
  playground: 'Resilience lab',
  observer: 'Live lab observer',
  replay: 'Recorded lab evidence',
  architecture: 'Architecture',
  notes: 'Field notes',
};
