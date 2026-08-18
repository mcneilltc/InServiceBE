export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Sites keep the acronym (siteName) as the canonical value used everywhere
// for data entry/reporting — fullName is an optional supplementary label,
// e.g. "ERRC" -> "Eastway Regional Recreation Center".
describe('Sites — optional fullName', () => {
  const createdSiteIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSiteIds.splice(0)) await db.collection('sites').doc(id).delete();
  });

  it('creates a site with a fullName', async () => {
    const response = await request(app)
      .post('/api/sites')
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'ERRC', fullName: 'Eastway Regional Recreation Center' });

    expect(response.status).toBe(201);
    createdSiteIds.push(response.body.id);
    expect(response.body.site.name).toBe('ERRC');
    expect(response.body.site.fullName).toBe('Eastway Regional Recreation Center');
  });

  it('defaults fullName to null when omitted', async () => {
    const response = await request(app)
      .post('/api/sites')
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'MCAC' });

    expect(response.status).toBe(201);
    createdSiteIds.push(response.body.id);
    expect(response.body.site.fullName).toBeNull();
  });

  it('updates fullName independently of siteName', async () => {
    const createResponse = await request(app)
      .post('/api/sites')
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'RTA' });
    const siteId = createResponse.body.id;
    createdSiteIds.push(siteId);

    const updateResponse = await request(app)
      .put(`/api/sites/${siteId}`)
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'RTA', fullName: 'Ramsey Training Academy' });

    expect(updateResponse.status).toBe(200);
    const doc = await db.collection('sites').doc(siteId).get();
    expect(doc.data()?.fullName).toBe('Ramsey Training Academy');
  });

  it('clears fullName when the update explicitly sends an empty string', async () => {
    const createResponse = await request(app)
      .post('/api/sites')
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'NRRC', fullName: 'North Regional Recreation Center' });
    const siteId = createResponse.body.id;
    createdSiteIds.push(siteId);

    await request(app)
      .put(`/api/sites/${siteId}`)
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'NRRC', fullName: '' });

    const doc = await db.collection('sites').doc(siteId).get();
    expect(doc.data()?.fullName).toBeNull();
  });

  it('leaves an existing fullName untouched when the update omits the field entirely', async () => {
    const createResponse = await request(app)
      .post('/api/sites')
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'DO', fullName: 'Double Oaks' });
    const siteId = createResponse.body.id;
    createdSiteIds.push(siteId);

    await request(app)
      .put(`/api/sites/${siteId}`)
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'DO' });

    const doc = await db.collection('sites').doc(siteId).get();
    expect(doc.data()?.fullName).toBe('Double Oaks');
  });

  it('GET /api/sites passes fullName through', async () => {
    const createResponse = await request(app)
      .post('/api/sites')
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'CD', fullName: 'Cordelia' });
    createdSiteIds.push(createResponse.body.id);

    const listResponse = await request(app)
      .get('/api/sites')
      .set('Cookie', authCookie({ role: 'trainer' }));

    expect(listResponse.status).toBe(200);
    const site = listResponse.body.find((s: any) => s.id === createResponse.body.id);
    expect(site.fullName).toBe('Cordelia');
  });
});
