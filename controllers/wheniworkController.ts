export {};
const { upsertShiftFromWebhookEvent } = require('../services/wheniworkService');

// Handles an inbound When I Work webhook event. Responds 200 quickly and
// delegates all mapping/persistence logic to wheniworkService so it stays
// unit-testable without Express. TODO(verify against WIW docs): the event
// envelope shape (event/type field name, nesting of the shift payload) is a
// placeholder — confirm against real WIW webhook payloads.
async function handleWheniworkWebhook(req: any, res: any, next: any) {
  try {
    const eventType = req.body?.event || req.body?.type;
    const shiftPayload = req.body?.shift || req.body?.data;

    if (!eventType || !shiftPayload) {
      return res.status(400).json({ message: 'Malformed webhook payload' });
    }

    await upsertShiftFromWebhookEvent(eventType, shiftPayload);
    res.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
}

module.exports = { handleWheniworkWebhook };
