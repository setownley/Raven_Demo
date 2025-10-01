#!/bin/bash
# Start the Python server in the background
python3 stanza_server.py &

# Start your existing Node.js app
npm start
