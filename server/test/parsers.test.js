import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisode, parseMovie, parseSeasonFolder, parseTitleYear, sortTitle } from '../src/services/parsers.js';

test('movie: "Title (Year)"', () => {
  assert.deepEqual(parseTitleYear('The Matrix (1999)'), { title: 'The Matrix', year: 1999 });
  assert.deepEqual(parseTitleYear('Под игото [1952]'), { title: 'Под игото', year: 1952 });
});

test('movie: year-like numbers in the title', () => {
  assert.deepEqual(parseTitleYear('Blade Runner 2049 (2017)'), { title: 'Blade Runner 2049', year: 2017 });
  assert.deepEqual(parseTitleYear('2012 (2009)'), { title: '2012', year: 2009 });
  assert.deepEqual(parseTitleYear('Blade.Runner.2049.2017.1080p.BluRay'), { title: 'Blade Runner 2049', year: 2017 });
});

test('movie: release names', () => {
  assert.deepEqual(parseTitleYear('The.Dark.Knight.2008.1080p.BluRay.x264-GRP'), { title: 'The Dark Knight', year: 2008 });
  assert.deepEqual(parseTitleYear('Inception_2010_720p'), { title: 'Inception', year: 2010 });
  assert.deepEqual(parseTitleYear('Some.Movie.1080p.WEB-DL'), { title: 'Some Movie', year: null });
  assert.deepEqual(parseTitleYear('Just A Title'), { title: 'Just A Title', year: null });
});

test('movie: year from the parent folder', () => {
  assert.deepEqual(parseMovie('movie', 'Heat (1995)'), { title: 'Heat', year: 1995 });
  assert.deepEqual(parseMovie('Heat (1995)', 'Whatever'), { title: 'Heat', year: 1995 });
  assert.deepEqual(parseMovie('heat', null), { title: 'heat', year: null });
});

test('season folders', () => {
  assert.equal(parseSeasonFolder('Season 01'), 1);
  assert.equal(parseSeasonFolder('season 3'), 3);
  assert.equal(parseSeasonFolder('S02'), 2);
  assert.equal(parseSeasonFolder('Сезон 4'), 4);
  assert.equal(parseSeasonFolder('Specials'), 0);
  assert.equal(parseSeasonFolder('Extras stuff'), null);
});

test('episodes: SxxEyy styles', () => {
  assert.deepEqual(parseEpisode('Show Name S01E02', null), { season: 1, episode: 2, showPart: 'Show Name', title: null });
  assert.deepEqual(parseEpisode('show.name.s01e02.720p.hdtv', null), { season: 1, episode: 2, showPart: 'show name', title: null });
  assert.deepEqual(parseEpisode('Show S02E10 - The Title', null), { season: 2, episode: 10, showPart: 'Show', title: 'The Title' });
  assert.deepEqual(parseEpisode('Show S01E01E02 Double', null), { season: 1, episode: 1, showPart: 'Show', title: 'Double' });
  assert.deepEqual(parseEpisode('S03E04', null), { season: 3, episode: 4, showPart: null, title: null });
});

test('episodes: 1x02 style', () => {
  assert.deepEqual(parseEpisode('Show Name 1x02', null), { season: 1, episode: 2, showPart: 'Show Name', title: null });
  assert.deepEqual(parseEpisode('Show - 3x15 - Title', null), { season: 3, episode: 15, showPart: 'Show', title: 'Title' });
});

test('episodes: number from the season folder', () => {
  assert.deepEqual(parseEpisode('Show - E05 - Title', 2), { season: 2, episode: 5, showPart: null, title: 'Title' });
  assert.deepEqual(parseEpisode('07 - Title', 1), { season: 1, episode: 7, showPart: null, title: 'Title' });
  assert.equal(parseEpisode('random file', 1), null);
  assert.equal(parseEpisode('Show Name 2019', null), null);
});

test('sort title', () => {
  assert.equal(sortTitle('The Matrix'), 'matrix');
  assert.equal(sortTitle('Под Игото'), 'под игото');
  assert.ok(sortTitle('Part 2') < sortTitle('Part 10'));
});
