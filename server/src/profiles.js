// Profiles aren't implemented yet: everything belongs to profile 1.
// User-data tables already have a profile_id column, so adding profiles later means
// resolving the profile from the request here (e.g. a header) and nothing else.

export const DEFAULT_PROFILE_ID = 1;

export function profileId(req) { // eslint-disable-line no-unused-vars
  return DEFAULT_PROFILE_ID;
}
