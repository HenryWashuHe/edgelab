import { describe, expect, it } from 'vitest';
import { navigateToPage, parsePageHash, type AppPage } from '../src/routes';

describe('section navigation and reload destination', () => {
  it.each<AppPage>(['operations', 'playground', 'observer', 'replay', 'architecture', 'notes'])(
    'keeps the selected section and hash aligned for %s',
    (page) => {
      const target = { hash: '#operations' };
      let selected: AppPage = 'operations';
      navigateToPage(page, target, (value) => {
        expect(parsePageHash(target.hash)).toBe(value);
        selected = value;
      });
      expect(selected).toBe(page);
      expect(parsePageHash(target.hash)).toBe(page);
    },
  );

  it.each(['', '#', '#unknown', '#REPLAY', '#replay?session=anything', 'replay'])(
    'uses Operations for an unsupported hash %j',
    (hash) => {
      expect(parsePageHash(hash)).toBe('operations');
    },
  );

  it('selects the section even when its hash is already present', () => {
    const selected: AppPage[] = [];
    navigateToPage('architecture', { hash: '#architecture' }, (page) => selected.push(page));
    expect(selected).toEqual(['architecture']);
  });

  it('updates the reload destination for consecutive internal links', () => {
    const target = { hash: '#notes' };
    const selected: AppPage[] = [];
    navigateToPage('playground', target, (page) => selected.push(page));
    navigateToPage('architecture', target, (page) => selected.push(page));
    expect(selected).toEqual(['playground', 'architecture']);
    expect(parsePageHash(target.hash)).toBe('architecture');
  });
});
