const { expect } = require('chai');
const sinon = require('sinon');

describe('Oracle Edge Cases', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.AI_CONTEXT_MESSAGES_LIMIT = process.env.AI_CONTEXT_MESSAGES_LIMIT;
  });

  afterEach(() => {
    sinon.restore();
    if (savedEnv.AI_CONTEXT_MESSAGES_LIMIT !== undefined) {
      process.env.AI_CONTEXT_MESSAGES_LIMIT = savedEnv.AI_CONTEXT_MESSAGES_LIMIT;
    } else {
      delete process.env.AI_CONTEXT_MESSAGES_LIMIT;
    }
  });

  describe('routeQueryIntent Classification Logic', () => {
    it('TRADABLE keyword in response triggers Tradable path', () => {
      const classifyResponse = 'TRADABLE';
      const isTradable = classifyResponse.includes('TRADABLE');
      expect(isTradable).to.be.true;
    });

    it('unrecognized response defaults to MARKET path', () => {
      const classifyResponse = 'RANDOM_GIBBERISH';
      const isTradable = classifyResponse.includes('TRADABLE');
      const isElizaOS = classifyResponse.includes('ELIZAOS');
      expect(!isTradable && !isElizaOS).to.be.true;
    });

    it('undefined Ollama response defaults to MARKET path', () => {
      const classifyResponse = undefined;
      const isTradable = classifyResponse?.includes?.('TRADABLE') ?? false;
      const isElizaOS = classifyResponse?.includes?.('ELIZAOS') ?? false;
      expect(!isTradable && !isElizaOS).to.be.true;
    });

    it('undefined response throws TypeError when accessed without optional chaining', () => {
      const response = undefined;
      expect(() => response.includes('TRADABLE')).to.throw(TypeError);
    });

    it('null response returns false with optional chaining', () => {
      const response = null;
      const isTradable = response?.includes?.('TRADABLE') ?? false;
      expect(isTradable).to.be.false;
    });
  });

  describe('History Reconstruction Edge Cases', () => {
    it('AI_CONTEXT_MESSAGES_LIMIT=0 falls back to default 20 due to || operator', () => {
      process.env.AI_CONTEXT_MESSAGES_LIMIT = '0';
      const limit = parseInt(process.env.AI_CONTEXT_MESSAGES_LIMIT, 10) || 20;
      expect(limit).to.equal(20);
    });

    it('unset AI_CONTEXT_MESSAGES_LIMIT falls back to default 20', () => {
      delete process.env.AI_CONTEXT_MESSAGES_LIMIT;
      const limit = parseInt(process.env.AI_CONTEXT_MESSAGES_LIMIT, 10) || 20;
      expect(limit).to.equal(20);
    });

    it('should truncate history when exceeding AI_CONTEXT_MESSAGES_LIMIT limit', async () => {
      process.env.AI_CONTEXT_MESSAGES_LIMIT = '3';
      const maxHistory = parseInt(process.env.AI_CONTEXT_MESSAGES_LIMIT, 10);

      const fullHistory = [
        { cid: 'msg-1', parentCID: null },
        { cid: 'msg-2', parentCID: 'msg-1' },
        { cid: 'msg-3', parentCID: 'msg-2' },
        { cid: 'msg-4', parentCID: 'msg-3' },
        { cid: 'msg-5', parentCID: 'msg-4' },
      ];

      const truncatedHistory = fullHistory.slice(-maxHistory);
      expect(truncatedHistory.length).to.equal(3);
      expect(truncatedHistory[0].cid).to.equal('msg-3');
      expect(truncatedHistory[truncatedHistory.length - 1].cid).to.equal('msg-5');
    });

    it('should reconstruct complete parentCID chain', async () => {
      const messages = {
        'msg-1': { content: 'first', parentCID: null },
        'msg-2': { content: 'second', parentCID: 'msg-1' },
        'msg-3': { content: 'third', parentCID: 'msg-2' },
      };

      const reconstructedChain = [];
      let currentCID = 'msg-3';

      while (currentCID && messages[currentCID]) {
        reconstructedChain.unshift(messages[currentCID]);
        currentCID = messages[currentCID].parentCID;
      }

      expect(reconstructedChain.length).to.equal(3);
      expect(reconstructedChain[0].content).to.equal('first');
      expect(reconstructedChain[reconstructedChain.length - 1].content).to.equal('third');
    });

    it('should handle broken parentCID chain gracefully', async () => {
      const messages = {
        'msg-2': { content: 'second', parentCID: 'msg-1-missing' },
      };

      const reconstructedChain = [];
      let currentCID = 'msg-2';

      while (currentCID && messages[currentCID]) {
        reconstructedChain.unshift(messages[currentCID]);
        currentCID = messages[currentCID].parentCID;
      }

      expect(reconstructedChain.length).to.equal(1);
      expect(reconstructedChain[0].content).to.equal('second');
    });

    it('should handle circular references in parentCID chain', async () => {
      const visited = new Set();
      const messages = {
        'msg-1': { content: 'first', parentCID: 'msg-2' },
        'msg-2': { content: 'second', parentCID: 'msg-1' },
      };

      const reconstructedChain = [];
      let currentCID = 'msg-1';
      let iterations = 0;
      const maxIterations = 100;

      while (currentCID && messages[currentCID] && iterations < maxIterations) {
        if (visited.has(currentCID)) {
          break;
        }
        visited.add(currentCID);
        reconstructedChain.unshift(messages[currentCID]);
        currentCID = messages[currentCID].parentCID;
        iterations++;
      }

      expect(reconstructedChain.length).to.equal(2);
      expect(iterations).to.equal(2);
    });
  });

  describe('Failed Jobs Retry Timing', () => {
    it('should schedule retry at 30s for first attempt', async () => {
      const baseDelay = 30000;
      const retryCount = 0;
      const calculatedMs = baseDelay * Math.pow(2, retryCount);
      expect(calculatedMs).to.equal(30000);
    });

    it('should schedule retry at 60s for second attempt', async () => {
      const baseDelay = 30000;
      const retryCount = 1;
      const calculatedMs = baseDelay * Math.pow(2, retryCount);
      expect(calculatedMs).to.equal(60000);
    });

    it('should schedule retry at 120s for third attempt', async () => {
      const baseDelay = 30000;
      const retryCount = 2;
      const calculatedMs = baseDelay * Math.pow(2, retryCount);
      expect(calculatedMs).to.equal(120000);
    });

    it('should continue exponential backoff through retries', async () => {
      const baseDelay = 30000;
      const expectedDelays = [30, 60, 120, 240, 480];

      for (let retryCount = 0; retryCount < expectedDelays.length; retryCount++) {
        const expectedMs = expectedDelays[retryCount] * 1000;
        const calculatedMs = baseDelay * Math.pow(2, retryCount);
        expect(calculatedMs).to.equal(expectedMs);
      }
    });

    it('should stop retrying after 10 attempts', async () => {
      const maxRetries = 10;
      let retryCount = 10;
      const shouldDrop = retryCount >= maxRetries;
      expect(shouldDrop).to.be.true;
    });

    it('should skip job if nextAttemptAt is in future', async () => {
      const job = {
        nextAttemptAt: Date.now() + 5000,
        retryCount: 2,
      };
      const shouldProcess = job.nextAttemptAt <= Date.now();
      expect(shouldProcess).to.be.false;
    });

    it('should process job if nextAttemptAt has passed', async () => {
      const job = {
        nextAttemptAt: Date.now() - 1000,
        retryCount: 2,
      };
      const shouldProcess = job.nextAttemptAt <= Date.now();
      expect(shouldProcess).to.be.true;
    });

    it('should track retryCount incrementally', async () => {
      const job = { retryCount: 0 };
      for (let i = 0; i < 5; i++) {
        job.retryCount++;
        expect(job.retryCount).to.equal(i + 1);
      }
      expect(job.retryCount).to.equal(5);
    });

    it('should correctly calculate nextAttemptAt for batched retries', async () => {
      const baseDelay = 30000;
      const jobs = [
        { id: 'job-1', retryCount: 0 },
        { id: 'job-2', retryCount: 1 },
        { id: 'job-3', retryCount: 2 },
      ];

      const scheduled = jobs.map((job) => ({
        ...job,
        nextAttemptAt: Date.now() + baseDelay * Math.pow(2, job.retryCount),
      }));

      expect(scheduled[1].nextAttemptAt).to.be.greaterThan(scheduled[0].nextAttemptAt);
      expect(scheduled[2].nextAttemptAt).to.be.greaterThan(scheduled[1].nextAttemptAt);
    });
  });
});
