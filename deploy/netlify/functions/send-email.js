// CommonJS — works on all Netlify Node versions with zero config required
const https = require('https');

exports.handler = function(event, context, callback) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  function done(code, obj) {
    callback(null, { statusCode: code, headers: headers, body: JSON.stringify(obj) });
  }

  if (event.httpMethod === 'OPTIONS') return callback(null, { statusCode: 200, headers: headers, body: '{}' });
  if (event.httpMethod !== 'POST')    return done(405, { error: 'Method Not Allowed' });

  var p;
  try { p = JSON.parse(event.body || '{}'); }
  catch(e) { return done(400, { error: 'Invalid JSON' }); }

  if (!p.to || !p.subject || !p.body) return done(400, { error: 'Missing to/subject/body' });

  var key = process.env.RESEND_API_KEY;
  console.log('key present:', !!key);
  if (!key) return done(500, { error: 'RESEND_API_KEY not set' });

  var loLine = [p.loName, p.loEmail, p.loPhone].filter(Boolean).join(' · ');
  var esc = function(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  var date = new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>'
    + '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">'
    + '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0">SLA Capital \u2014 Loan Application</h1>'
    + '<p style="color:rgba(255,255,255,.5);font-size:12px;margin:4px 0 0">Submitted ' + date + '</p></div>'
    + '<div style="padding:24px"><pre style="white-space:pre-wrap;font-family:monospace;font-size:12px;background:#f7f5f1;padding:16px;border-radius:6px">' + esc(p.body) + '</pre>'
    + (loLine ? '<p style="margin-top:16px;font-size:12px;color:#666"><strong>Submitted by:</strong> ' + esc(loLine) + '</p>' : '')
    + '</div></div></body></html>';

  var payload = JSON.stringify({
    from: 'SLA Capital <noreply@leads.slacapital.com>',
    to: [p.to],
    subject: p.subject,
    text: p.body,
    html: html,
    reply_to: p.loEmail || undefined,
  });

  var req = https.request({
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, function(res) {
    var chunks = [];
    res.on('data', function(c) { chunks.push(c); });
    res.on('end', function() {
      var text = Buffer.concat(chunks).toString();
      console.log('Resend status:', res.statusCode, text.slice(0,200));
      var d;
      try { d = JSON.parse(text); } catch(e) { d = { error: text }; }
      if (res.statusCode >= 300) return done(res.statusCode, { error: d.message || d.error || 'Resend error' });
      done(200, { success: true, id: d.id });
    });
  });

  req.on('error', function(e) {
    console.log('Request error:', e.message);
    done(502, { error: 'Network error: ' + e.message });
  });

  req.write(payload);
  req.end();
};
