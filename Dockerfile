# Use an official lightweight Node.js image.
FROM node:16-alpine

# Set the working directory in the container.
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies.
RUN npm install

# Copy the rest of your application code.
COPY . .

# Expose the port that your EmberPlus server uses.
EXPOSE 9000

# Set default environment variables (can be overridden at runtime)
ENV VMIX_HOST=localhost
ENV VMIX_PORT=8099

# Run the application.
CMD [ "node", "bridge.js" ]
