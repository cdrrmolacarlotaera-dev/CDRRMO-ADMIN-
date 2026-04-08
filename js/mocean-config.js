/**
 * Mocean credentials for the CDRRMO Admin panel only.
 * This file lives inside CDRRMO(ADMIN) so the admin project can be its own GitHub repo
 * without importing from the citizen CDRRMO app folder.
 *
 * Set API_TOKEN (often apit-...) OR API_KEY + API_SECRET, and FROM (sender ID from Mocean).
 */
export const MOCEAN_CONFIG = {
  API_KEY: '',
  API_SECRET: '',
  API_TOKEN: 'apit-DB4g23siFpJtIT7KcB4bpJzcAqFKLFsc-6khWd',
  BASE_URL: 'https://rest.moceanapi.com/rest/2/sms',
  FROM: 'MOCEAN',
  cdrrmoNumbers: [],
};
