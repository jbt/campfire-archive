var express = require('express');
var CA = require('./CampfireArchiver');

var app = express();

app.use(express.urlencoded());
app.use(express['static'](__dirname + '/public'));

var archivers = {};


app.get('/go/:subdomain/:token', function(req, res, next){
  var sd = req.param('subdomain');
  var tok = req.param('token');

  if(archivers[sd]){
    if(archivers[sd].token === tok){
      return res.json({ state: 'alreadyRunning' });
    }else{
      return res.json({ state: 'badToken' });
    }
  }

  var a = archivers[sd] = new CA(sd, tok, uai);
  a.run(function(err){
    console.log(err);
    if(!err){
      app.use('/archive/' + sd + '/' + tok, express['static'](a.archiveDir));
    }
  });

  res.json({ state: 'new' });
});

app.get('/progress/:subdomain/:token', function(req, res, next){
  var sd = req.param('subdomain');
  var tok = req.param('token');

  if(archivers[sd] && archivers[sd].token === tok){
    return res.json(archivers[sd].progress());
  }
  res.json({ nope: 'notfound' });
});


app.get('/download/:subdomain/:token', function(req, res, next){
  var sd = req.param('subdomain');
  var tok = req.param('token');

  if(archivers[sd] && archivers[sd].token === tok){
    return res.download(archivers[sd].archiveFile, sd + '.zip');
  }
  res.send(404);
});


app.get('/cleanup/:subdomain/:token', function(req, res, next){
  var sd = req.param('subdomain');
  var tok = req.param('token');

  if(archivers[sd] && archivers[sd].token === tok){
    return archivers[sd].cleanup(function(){
      console.log(arguments);
      delete archivers[sd];
      res.send({ done: true });
    });
  }
  res.send(404);
});



app.listen(process.env.PORT || 3000);
