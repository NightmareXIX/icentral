# Use a lightweight Node.js image
FROM node:22-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json ./
RUN npm install

# Copy the rest of the source code
COPY . .

# Start the server (assuming your entry file is index.js)
CMD ["node", "index.js"]
