/**
 * Reading the project out of the address bar.
 *
 * Only the route half is tested here — the store lookup needs a browser, and
 * the part that gets edge cases wrong is this one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { routeSubject } from '../src/lib/active-project.ts';

describe('what a route is about', () => {
  it('names the project on a board', () => {
    assert.deepEqual(routeSubject('/projects/p1'), { entity: 'project', ref: 'p1' });
  });

  it('follows a cycle, a module and a task to whatever they belong to', () => {
    assert.deepEqual(routeSubject('/cycles/c1'), { entity: 'cycle', ref: 'c1' });
    assert.deepEqual(routeSubject('/modules/m1'), { entity: 'module', ref: 'm1' });
    assert.deepEqual(routeSubject('/t/WEB-42'), { entity: 'task', ref: 'WEB-42' });
  });

  it('is not fooled by the create form', () => {
    // `/projects/new` matches the prefix and is a form. Treating "new" as an id
    // would file the next task into a project that does not exist.
    assert.equal(routeSubject('/projects/new'), undefined);
  });

  it('ignores anything past the first segment', () => {
    assert.deepEqual(routeSubject('/projects/p1/settings'), { entity: 'project', ref: 'p1' });
  });

  it('says nothing about the screens that are about nothing', () => {
    for (const path of ['/', '/inbox', '/projects', '/pages', '/teams', '/settings', '/chat/x']) {
      assert.equal(routeSubject(path), undefined, path);
    }
  });

  it('decodes a ref that was escaped into the URL', () => {
    assert.deepEqual(routeSubject('/t/WEB%2D42'), { entity: 'task', ref: 'WEB-42' });
  });

  it('is not confused by a prefix that is only a prefix', () => {
    // `/tasks` starts with neither `/t/` nor anything else here.
    assert.equal(routeSubject('/tasks'), undefined);
    assert.equal(routeSubject('/projectsomething'), undefined);
  });
});
