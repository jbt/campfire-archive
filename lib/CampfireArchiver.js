var path = require('path');
var fs = require('fs');

var archiver = require('archiver');
var request = require('request');
var moment = require('moment');
var mkdirp = require('mkdirp');
var async = require('async');
var ejs = require('ejs');

var emoji = require('./emoji/emoji.json');

var CampfireArchiver = module.exports = function(subdomain, token){
  this.dataRoot = path.resolve('campfire/' + subdomain);
  this.stateFile = path.resolve(this.dataRoot, 'state.json');
  mkdirp.sync(this.dataRoot);
  this.loadState();
  this.state.token = this.token = token;
  this.state.subdomain = this.subdomain = subdomain;
};

CampfireArchiver.prototype.loadState = function(){
  this.state = {};
  if(fs.existsSync(this.stateFile)){
    var json = fs.readFileSync(this.stateFile).toString();
    try {
      json = JSON.parse(json);
      this.state = json;
    }catch(e){
      console.error('Unable to read state file.');
      console.error('If you had a half-complete archive, it will be started from scratch');
    }
  }
};

CampfireArchiver.prototype.saveState = function(){
  fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
};

CampfireArchiver.prototype.run = function(cb){
  var self = this;
  // this.compressArchive(function(){});return;
  async.series([
    this.getRooms.bind(this),
    this.fetchAllTranscripts.bind(this),
    this.fetchUsers.bind(this),
    this.fetchUploads.bind(this),
    this.renderArchive.bind(this),
    this.compressArchive.bind(this)
  ], cb);
};

CampfireArchiver.prototype.progress = function(){
  var p = [];
  var self = this;
  if(this.gettingRooms){
    p.push({ title: 'Fetching room list', done: this.gettingRooms === 2 });
  }
  if(this.gettingTranscripts){
    var todo = this.transcripts.length;
    var done = this.transcripts.filter(function(t){ return t.fetched; }).length;
    p.push({ title: 'Fetching transcripts', progress: [todo, done], done: todo == done });
  }
  if(this.gettingUsers){
    var todo = this.usersToFetch.length;
    var done = Object.keys(this.users).length;
    p.push({ title: 'Fetching users', progress: [todo, done], done: todo == done });
  }
  if(this.gettingUploads){
    var todo = this.uploads.length;
    var done = this.uploads.filter(function(u){
      try {
        var x = self.state.uploads[u.room_id].uploads[u.id];
        return x && (x.complete || x.notFound);
      }catch(e){
        return false;
      }
    }).length;
    p.push({ title: 'Fetching uploads', progress: [todo, done], done: todo == done });
  }
  if(this.creatingArchive){
    var todo = this.transcripts.length;
    var done = this.transcripts.filter(function(t){ return t.rendered; }).length;
    p.push({ title: 'Creating archive', progress: [todo, done], done: todo == done });
  }
  if(this.compressingArchive){
    var todo = this.filesToCompress;
    var done = this.filesCompressed;
    p.push({ title: 'Compressing archive', progress: [todo, done], done: this.compressingArchive === 2 });
  }

  if(this.compressingArchive === 2){
    return { done: true }
  }

  return p;
};

CampfireArchiver.prototype.urlRoot = function(){
  return 'https://' + this.state.subdomain + '.campfirenow.com/';
};

CampfireArchiver.prototype.getJson = function(url, cb){
  url = this.urlRoot() + url;
  request({
    url: url,
    auth: { user: this.state.token, pass: 'X' },
    json: true,
    headers: { 'User-Agent': 'Camfire Archiver' }
  }, function(err, response, body){
    cb(err, body);
  });
};

CampfireArchiver.prototype.p = function(filePath){
  return path.resolve(this.dataRoot, filePath);
};

CampfireArchiver.prototype.httpGet = function(url, cb){
  return request({
    url: url,
    auth: { user: this.state.token, pass: 'X' },
    encoding: null
  }, cb);
};

CampfireArchiver.prototype.getRooms = function(cb){
  this.gettingRooms = true;
  var roomState = this.state.rooms || (this.state.rooms = {});

  if(roomState.complete){
    this.rooms = JSON.parse(fs.readFileSync(this.p('rooms.json')).toString());
    this.gettingRooms = 2;
    return process.nextTick(function(){ cb(null); });
  }

  this.getJson('rooms.json', function(err, rooms){
    if(err) return cb(err);

    this.rooms = rooms;
    fs.writeFileSync(this.p('rooms.json'), JSON.stringify(rooms, null, 2));
    roomState.complete = true;
    this.saveState();
    this.gettingRooms = 2;

    cb();
  }.bind(this));
};

CampfireArchiver.prototype.queueAllRoomDownloads = function(){
  if(!this.state.transcripts) this.state.transcripts = {};

  this.transcripts = [];

  this.rooms.rooms.forEach(this.queueRoomDownloads.bind(this));
};

CampfireArchiver.prototype.queueRoomDownloads = function(room){
  var startDate = new Date(room.created_at);
  var id = room.id;

  var d = new Date(startDate - (startDate % 864e5));

  var state = this.state.transcripts[id];
  if(!state) state = this.state.transcripts[id] = {};

  var tq = this.transcripts;
  var p = this.p.bind(this);
  var save = this.saveState.bind(this);
  var get = this.getJson.bind(this);

  function addTranscript(date){
    var y = date.getFullYear();
    var m = date.getMonth() + 1;
    var d = date.getDate();

    var key = y + '-' + m + '-' + d;

    var transcriptState = state[key];
    if(!transcriptState) transcriptState = state[key] = {};

    var f = p('rooms/' + id + '/transcripts/' + key + '.json');

    var item = { id: id, y: y, m: m, d: d, file: f, date: date };

    function fetchFile(cb){
      fs.readFile(f, function(err, json){
        if(err) return fetchRemote(cb);
        try{
          json = JSON.parse(json);
          item.fetched = true;
          cb(null, json);
        }catch(e){
          fetchRemote(cb);
        }
      });
    }
    function fetchRemote(cb){
      get('room/' + id + '/transcript/' + y + '/' + m + '/' + d + '.json', function(err, json){
        if(err) return cb(err);
        if(!json) return cb(404);
        mkdirp(p('rooms/' + id + '/transcripts'), function(){
          fs.writeFile(f, JSON.stringify(json, null, 2), function(err){
            if(err) return cb(err);
            transcriptState.complete = true;
            save();
            item.fetch = fetchFile;
            item.source = 'file';
            item.fetched = true;
            cb(null, json);
          });
        });
      });
    }

    if(transcriptState.complete){
      item.fetch = fetchFile;
      item.source = 'file';
    }else{
      item.fetch = fetchRemote;
      item.source = 'campfire';
    }
    tq.push(item);
  }

  while(d < Date.now()){
    addTranscript(d);
    d = new Date(+d + 864e5);
  }
};

CampfireArchiver.prototype.fetchAllTranscripts = function(cb){
  this.queueAllRoomDownloads();
  this.gettingTranscripts = true;
  async.eachLimit(this.transcripts, 20, function(item, cb){
    console.log('Fetching %s-%s-%s for room %s from %s', item.y, item.m, item.d, item.id, item.source);
    item.fetch(function(err, t){
      if(err) return cb(err);
      this.processTranscript(t);
      cb(null);
    }.bind(this));
  }.bind(this), cb);
};

CampfireArchiver.prototype.processTranscript = function(transcript){
  transcript.messages.forEach(this.processTranscriptMessage.bind(this));
};

CampfireArchiver.prototype.processTranscriptMessage = function(msg){
  if(msg.user_id){
    if(!this.usersToFetch) this.usersToFetch = [];
    if(this.usersToFetch.indexOf(msg.user_id) === -1){
      this.usersToFetch.push(msg.user_id);
    }
  }
  if(msg.type === 'UploadMessage'){
    if(!this.uploads) this.uploads = [];
    this.uploads.push(msg);
  }
};

CampfireArchiver.prototype.fetchUsers = function(cb){
  this.gettingUsers = true;
  mkdirp.sync(this.p('users'));
  this.users = {};
  async.eachLimit(this.usersToFetch, 10, function(u, cb){
    console.log('Getting user %s', u);
    this.getJson('users/' + u + '.json', function(err, json){
      if(err) return cb(err);
      this.users[u] = json.user;
      fs.writeFile(this.p('users/' + u + '.json'), JSON.stringify(json, null, 2), cb);
    }.bind(this));
  }.bind(this), cb);
};

CampfireArchiver.prototype.fetchUploads = function(cb){
  this.gettingUploads = true;
  if(!this.state.uploads) this.state.uploads = {};
  async.eachLimit(this.uploads, 10, this.fetchUpload.bind(this), cb);
};


CampfireArchiver.prototype.fetchUpload = function(u, cb){
  var room = this.state.uploads[u.room_id] || (this.state.uploads[u.room_id] = {});
  if(!room.uploads) room.uploads = {};
  var uState = room.uploads[u.id];
  if(!uState) uState = room.uploads[u.id] = {};

  var p = this.p.bind(this);

  var jsonFile = p('rooms/' + u.room_id + '/uploads/' + u.id + '/upload.json');

  var save = this.saveState.bind(this);
  var get = this.getJson.bind(this);
  var http = this.httpGet.bind(this);

  function fetchJsonLocal(cb){
    fs.readFile(jsonFile, function(err, json){
      if(err) return fetchJsonRemote(cb);
      try{
        json = JSON.parse(json);
      }catch(e){
        return fetchJsonRemote(cb);
      }
      cb(null, json);
    });
  }
  function fetchJsonRemote(cb){
    get('room/' + u.room_id + '/messages/' + u.id + '/upload.json', function(err, json){
      if(err) return cb(err);
      if(!json || !json.upload){
        uState.notFound = true;
        save();
        console.log('Upload %s not found', u.id);
        return cb(null, {notFound:true});
      }

      json.upload.name = json.upload.name.replace(/\?/g, '_');

      mkdirp(p('rooms/' + u.room_id + '/uploads/' + u.id), function(){
        fs.writeFile(jsonFile, JSON.stringify(json, null, 2), function(err){
          if(err) return cb(err);
          uState.json = true;
          save();
          cb(null, json);
        });
      });
    });
  }



  function dl(remote, basename, sz, cb){
    console.log('Downloading %s %s', basename, sz);
    http(remote, function(err, resp, body){
      if(err) return cb(err);
      fs.writeFile(p('rooms/' + u.room_id + '/uploads/' + u.id + '/' + basename), body, function(err){
        if(err) return cb(err);
        uState.complete = true;
        save();
        cb();
      });
    });
  }

  if(uState.complete || uState.notFound){
    console.log('Skipping file %s', u.body);
    return setTimeout(cb, 1);
  }

  var fn = uState.json ? fetchJsonLocal : fetchJsonRemote;

  fn(function(err, json){
    if(err) return cb(err);
    if(json.notFound) return cb();
    dl(json.upload.full_url, json.upload.name, json.upload.byte_size, cb);
  });
};

CampfireArchiver.prototype.renderArchive = function(cb){
  this.creatingArchive = true;
  mkdirp.sync(this.p('archive'));
  fs.writeFileSync(this.p('archive/style.css'), fs.readFileSync(__dirname + '/css/style.css'));
  fs.writeFileSync(this.p('archive/emoji-16.png'), fs.readFileSync(__dirname + '/emoji/16.png'));
  async.eachSeries(this.rooms.rooms, this.renderRoom.bind(this), function(err){
    if(err) return cb(err);
    var tmpl = fs.readFileSync(__dirname + '/templates/index.ejs').toString();

    var html = ejs.render(tmpl, this.rooms);

    fs.writeFile(this.p('archive/index.html'), html, cb);
  }.bind(this));
};

CampfireArchiver.prototype.renderRoom = function(room, cb){
  var id = room.id;
  mkdirp.sync(this.p('archive/' + id));
  var transcripts = this.transcripts.filter(function(t){ return t.id == id; });

  transcripts.forEach(function(t, i){
    t.prev = transcripts[i-1];
    t.next = transcripts[i+1];
  });

  transcripts.forEach(function(t){ t.room = room; });

  async.eachSeries(transcripts, this.renderTranscript.bind(this), function(err){
    if(err) return cb(err);

    if(!this.roomTemplate) this.roomTemplate = fs.readFileSync(__dirname + '/templates/room.ejs').toString();

    var html = ejs.render(this.roomTemplate, room);

    fs.writeFile(this.p('archive/' + room.id + '/index.html'), html, cb);
  }.bind(this));
};

CampfireArchiver.prototype.renderTranscript = function(t, cb){
  var p = 'archive/' + t.room.id + '/' + t.y + '/' + ('00'+t.m).slice(-2) + '/' + ('00'+t.d).slice(-2) + '.html';
  var f = this.p(p);

  t.rendering = true;

  console.log('Generating %s', p);

  t.fetch(function(err, data){
    if(err) return cb(err);

    if(!t.room.activity) t.room.activity = {};
    if(!t.room.activity[t.y]) t.room.activity[t.y] = {};

    t.room.activity[t.y][t.m+'/'+t.d] = data.messages.length;

    data.room = t.room;
    data.next = t.next;
    data.prev = t.prev;
    data.date = t.date;
    data.year = t.y;
    data.month = t.m;
    data.day = t.d;
    data.renderMsg = this.renderMessage.bind(this);
    data.moment = moment;
    data.rooms = this.rooms.rooms;
// return cb();
    var l, m = [], q = [];
    data.messages.forEach(function(msg){
      if(msg.type === 'TextMessage' || msg.type === 'PasteMessage' || msg.type === 'UploadMessage' || msg.type === 'TweetMessage' || msg.type === 'SoundMessage'){
        if(msg.user_id === l){
          q.push(msg);
        }else{
          if(q.length) m.push({ type: 'SomeMessages', user_id: l, msgs: q });
          q = [msg];
          l = msg.user_id;
        }
      }else{
        if(q.length) m.push({ type: 'SomeMessages', user_id: l, msgs: q });
        q = [];
        l = false;
        m.push(msg);
      }
    });
    if(q.length) m.push({ type: 'SomeMessages', user_id: l, msgs: q });

    data.messages = m;

    if(!this.transcriptTemplate) this.transcriptTemplate = fs.readFileSync(__dirname + '/templates/transcript.ejs').toString();

    var html = ejs.render(this.transcriptTemplate, data);


    mkdirp(path.dirname(f), function(){
      t.rendered = true;
      fs.writeFile(f, html, cb);
    });
  }.bind(this));
};

CampfireArchiver.prototype.getUser = function(id){
  return this.users[id];
};

  function _escape(s){return(""+s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

CampfireArchiver.prototype.getEmoji = function(code){
  return emoji.filter(function(e){
    return e.short_name === code.toLowerCase()   || e.short_names.indexOf(code.toLowerCase()) !== -1
  })[0];
};

CampfireArchiver.prototype.linkify = function(str){

  var imgs = [];

  str = _escape(str);
  var original = str;
  str = str.replace(/([\s\r\t\(\)]|^)(https?:\/\/cl\.ly\/[^\s\r\t\(\)]+)/ig, function(_, a, l){
    imgs.push([l, l+'/i.png']);
    return a + '<a href="' + l + '" target="_blank">' + l + '</a>';
  });
  str = str.replace(/([\s\r\t\(\)]|^)(https?:\/\/[^\s\r\t\(\)]+)/ig, function(_, a, l){
    if(/\.(png|jpg|gif|jpeg)$/i.test(l)){
      imgs.push([l, l]);
      return a + '<a href="' + l + '" target="_blank">' + l + '</a>';
    }else{
      return a + '<a href="' + l + '" target="_blank">' + l + '</a>';
    }
  });
  // TODO things like youtube links in here

  // special case if text is *only* an image; don't show link
  if(imgs.length === 1 && original === imgs[0][0]){
    return '<a href="' + imgs[0][0] + '" target="_blank"><img src="' + imgs[0][1] + '" /></a>';
  }

  str = str.replace(/:([a-z0-9\-_]+):/g, function(_, a){
    var e = this.getEmoji(a);
    if(!e) return _;

    return '<span class="emoji" style="background-position:-'+(e.sheet_x*16)+'px -'+(e.sheet_y*16)+'px;"></span>';
  }.bind(this))



  return str + (imgs.length ? ('</span>' + imgs.map(function(i){
    return '<div><a href="' + i[0] + '" target="_blank"><img src="' + i[1] + '" /></a></div>';
  }).join('') + '<span>') : '');
};

CampfireArchiver.prototype.renderMessage = function(msg){
  if(msg.type === 'UploadMessage') return this.dealWithUploadMessage(msg);
  if(!this.msgTemplates) this.msgTemplates = {};
  if(!this.msgTemplates[msg.type]){
    try{this.msgTemplates[msg.type] = fs.readFileSync(__dirname + '/templates/' + msg.type + '.ejs').toString();
    }catch(e){ console.log(msg.type); this.msgTemplates[msg.type] = ''}
  }
  if(!msg.type) console.log(msg);
  msg.moment = moment;
  msg.user = this.getUser.bind(this);
  msg.renderMsg = this.renderMessage.bind(this);
  msg.linkify = this.linkify.bind(this);
  return ejs.render(this.msgTemplates[msg.type], msg);
};

CampfireArchiver.prototype.dealWithUploadMessage = function(msg){
  var uploadState = this.state.uploads[msg.room_id].uploads[msg.id];

  if(uploadState.notFound){
    return '<div class="upload"><span class="txt">' + _escape(msg.body) + '</span><span class="deleted">[deleted]</span></div>';
  }

  var jsonFile = this.p('rooms/' + msg.room_id + '/uploads/' + msg.id + '/upload.json');
  var data = JSON.parse(fs.readFileSync(jsonFile).toString());

  var srcPath = this.p('rooms/' + msg.room_id + '/uploads/' + msg.id + '/' + data.upload.name);
  var destPath = this.p('archive/' + msg.room_id + '/uploads/' + msg.id + '/' + data.upload.name);
  mkdirp.sync(path.dirname(destPath));

  fs.writeFileSync(destPath, fs.readFileSync(srcPath));

  var relativePath = '../../uploads/' + msg.id + '/' + data.upload.name;

  var body = _escape(msg.body);

  if(/image\//.test(data.upload.content_type)){
    body = '<img src="' + encodeURI(relativePath) + '"/>';
  }

  return '<div class="upload"><a href="' + encodeURI(relativePath) + '" target="_blank">' + body + '</a></div>';
};

CampfireArchiver.prototype.compressArchive = function(cb){
  var dir = this.archiveDir = this.p('archive');
  var zip = this.archiveFile = this.p(this.subdomain + '.zip');

  try{ fs.unlinkSync(zip); }catch(e){}

  this.compressingArchive = true;

  function walkDir(dir){
    return [].concat.apply([], fs.readdirSync(dir).map(function(f){
      f = dir + '/' + f;
      return fs.statSync(f).isDirectory() ? walkDir(f) : f;
    }));
  }

  var files = walkDir(dir);
  files = files.map(function(f){ return f.replace(dir + '/', ''); });

  this.filesToCompress = files.length;
  this.filesCompressed = 0;

  var output = fs.createWriteStream(zip);
  var archive = archiver('zip');

  output.on('close', function() {
    this.compressingArchive = 2;
    cb(null);
  }.bind(this));

  archive.on('error', function(err) {
    cb(err);
  });

  archive.on('entry', function(){
    this.filesCompressed += 1;
  }.bind(this));

  archive.pipe(output);

  files.forEach(function(f){
    archive.file(path.join(dir, f), { name: f });
  });

  archive.finalize();
};

CampfireArchiver.prototype.cleanup = function(cb){

  function cleanDir(dir){
    fs.readdirSync(dir).forEach(function(f){
      f = dir + '/' + f;
      fs.statSync(f).isDirectory() ? cleanDir(f) : fs.unlinkSync(f);
    });
    fs.rmdir(dir);
  }

  cleanDir(this.dataRoot);
  cb();
}
