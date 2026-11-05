const path = require('node:path');
const amqp = require(require.resolve('amqplib', { paths: [path.resolve(process.argv[2])] }));
(async () => {
  const connection = await amqp.connect('amqp://guest:guest@localhost:5672');
  let timer;
  try {
    const ch = await connection.createChannel();
    const queue = await ch.assertQueue('', { exclusive: true, autoDelete: true });
    await ch.bindQueue(queue.queue, 'spacefractions.events', 'score.updated');
    let resolve;
    const event = new Promise((res, reject) => {
      resolve = res;
      timer = setTimeout(() => reject(new Error('event timeout')), 8000);
    });
    await ch.consume(queue.queue, msg => { if (msg) { ch.ack(msg); resolve(JSON.parse(msg.content.toString())); } });
    const base = process.env.SPACE_BASE_URL;
    async function api(method, url, actor, body) {
      const response = await fetch(base+url, { method, headers: { Authorization: 'Bearer '+process.env[actor], 'Content-Type':'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error('HTTP '+response.status);
      return response.json();
    }
    const { questions } = await api('GET','/api/admin/questions','SPACE_ADMIN_TOKEN');
    const q = questions[0];
    const game = await api('POST','/api/games','SPACE_USER_TOKEN',{questionIds:[q.id]});
    const result = await api('POST',`/api/games/${game.id}/answers`,'SPACE_USER_TOKEN',{questionId:q.id,answer:q.correctAnswer});
    const received = await event;
    const ok = received.gameId === game.id && received.score === 1 && result.score === 1;
    console.log(JSON.stringify({kind:'independent_rabbitmq_delivery',status:ok?'passed':'failed',event:received.event,score:received.score}));
    process.exitCode = ok ? 0 : 1;
  } finally {
    clearTimeout(timer);
    await connection.close();
  }
})().catch(e => { console.log(JSON.stringify({status:'failed',error_type:e.name})); process.exitCode=1; });
