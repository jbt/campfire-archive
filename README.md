# Campfire Archiver

Moved away from [Campfire](//campfirenow.com) recently but want an archive of all your data? Try this.

```sh
$ npm install -g campfire-archive
$ campfire-archive
```

Then go to [localhost:3000](http://localhost:3000/), enter your details, and you're away!

Data is downloaded and processed in a directory called `campfire` inside your current directory, so make sure you run it from a directory with enough space!

# Update

Added a new 'User-Agent' field to the user interface.

This avoids the following issue:
https://github.com/jbt/campfire-archive/issues/1