import { Router } from 'express';
import * as auth from '../services/authService.js';
import { destroySession } from '../services/sessionService.js';

const router = Router();

router.get('/login', async (req, res) => {
  if (!auth.isOIDCEnabled()) {
    req.session.userId    = `demo-${Date.now()}`;
    req.session.userEmail = 'demo@example.com';
    req.session.userName  = 'Demo User';
    await req.saveSession();
    return res.redirect('/');
  }
  try {
    const url = auth.getAuthorizationUrl(req.session);
    await req.saveSession();
    res.redirect(url);
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).send('Authentication error. Please try again.');
  }
});

router.get('/callback', async (req, res) => {
  try {
    const user = await auth.handleCallback(req);
    req.session.userId      = user.userId;
    req.session.userEmail   = user.email;
    req.session.userName    = user.name;
    req.session.accessToken = user.accessToken;
    delete req.session.oidcState;
    await req.saveSession();
    res.redirect('/');
  } catch (err) {
    console.error('[Auth] Callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

router.get('/logout', (req, res) => {
  destroySession(res, req.sessionId).then(() => res.redirect('/'));
});

router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({
      loggedIn: true,
      userId:   req.session.userId,
      email:    req.session.userEmail,
      name:     req.session.userName,
    });
  } else {
    res.json({ loggedIn: false });
  }
});

export default router;
