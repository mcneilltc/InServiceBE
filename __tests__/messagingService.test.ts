import { sendEmailWithProvider } from '../services/messagingService';

describe('sendEmailWithProvider', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('sends mail through Microsoft Graph with the provided access token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: jest.fn().mockResolvedValue({}),
    });
    global.fetch = fetchMock as any;

    const result = await sendEmailWithProvider({
      provider: 'microsoft',
      accessToken: 'ms-token',
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ms-token',
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(result.ok).toBe(true);
  });
});
