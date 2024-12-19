const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const mysql = require('mysql');
const { Queue, Worker } = require('bullmq');

const app = express();
const PORT = 8080;
const HOST = '192.3.117.69';

// Middleware untuk parsing JSON
//app.use(bodyParser.json());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// Konfigurasi koneksi MySQL
const db = mysql.createConnection({
    host: 'localhost',
    user: 'pamsimas',
    password: 'ADJpx2s8ENwmKjPz',
    database: 'pamsimas',
});

const connection = {
    host: 'localhost',
    port: 6379
};

// Hubungkan ke MySQL
db.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
    } else {
        console.log('Connected to MySQL database.');
    }
});

const commandQueue = new Queue('commandQueue', { connection });
// Fungsi untuk menambahkan data ke antrian
async function addToQueue(queueName, data) {
    await commandQueue.add(queueName, data);
}

const commandWorker = new Worker('commandQueue', async job => {
    // Job data yang masuk adalah perintah dari antrian
    const { phoneNumber, messageContent } = job.data;
    console.log(`Processing job for phone number: ${phoneNumber}`);

    // Panggil fungsi handleCommand untuk memproses perintah
    await handleCommand({ phoneNumber, messageContent });
}, { connection });

commandWorker.on('completed', (job) => {
    console.log(`Job completed with result: ${job.returnvalue}`);
});

commandWorker.on('failed', (job, err) => {
    console.error(`Job failed with error: ${err.message}`);
});

// Fungsi untuk konversi nama bulan ke angka bulan
function convertMonthNameToNumber(month) {
    const months = [
        'januari', 'februari', 'maret', 'april', 'mei', 'juni',
        'juli', 'agustus', 'september', 'oktober', 'november', 'desember'
    ];
    if (isNaN(month)) {
        // Jika bulan adalah teks
        return months.indexOf(month.toLowerCase()) + 1; // +1 karena index dimulai dari 0
    }
    // Jika bulan adalah angka
    const monthNumber = parseInt(month, 10);
    return monthNumber >= 1 && monthNumber <= 12 ? monthNumber : 0; // Pastikan bulan valid
}

// Fungsi untuk mengirim pesan WhatsApp
async function sendWhatsAppMessage(phoneNumber, message) {
    const url = 'http://192.3.117.69:3334/message/text?key=55b2531a-861c-40af-8194-4fa911d3cc39';

    return axios.post(
        url,
        {
            id: phoneNumber,
            message: message,
        },
        {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
    );
}

// Fungsi untuk memproses perintah dalam antrian
async function handleCommand(command) {
    const { phoneNumber, messageContent } = command;
    console.log('proses antrian')

    // Periksa nomor telepon di database
    const checkUserQuery = `SELECT * FROM pelanggan WHERE no_telpon = ?`;
    db.query(checkUserQuery, [phoneNumber], async (err, userResults) => {
        if (err) {
            console.error('Database query error:', err);
            return;
        }

        if (userResults.length === 0) {
            const message = 'Nomor Anda tidak terdaftar di sistem kami. Silakan hubungi layanan pelanggan.';
            console.log(`${message}`);
            return;
        }

        // Logika untuk menangani pesan masuk
        if (messageContent.includes('info') && messageContent.includes('tagihan')) {
            // Ambil bulan dan tahun dari pesan
            const monthMatch = messageContent.match(/bulan\s(\w+)\s(\d{4})/); // Format "bulan <nama_bulan> <tahun>"
            if (!monthMatch || monthMatch.length < 3) {
                const message = 'Format pesan salah. Gunakan format "info tagihan bulan <nama_bulan>/<angka_bulan> <tahun>".';
                await sendWhatsAppMessage(phoneNumber, message);
                return;
                }

            const monthInput = monthMatch[1];
            const yearInput = monthMatch[2];
            const monthNumber = convertMonthNameToNumber(monthInput);

            if (monthNumber === 0) {
                const message = 'Nama atau angka bulan tidak valid.';
                await sendWhatsAppMessage(phoneNumber, message);
                return;
            }

            const query = `SELECT a.total_pemakaian AS totalPemakaian, a.total_tagihan AS totalTagihan , a.status AS statusTagihan
                           FROM tagihan a, pelanggan b
                           WHERE a.id_pelanggan = b.id_pelanggan AND b.no_telpon = ? AND MONTH(a.tgl_tagihan) = ? AND YEAR(a.tgl_tagihan) = ?`;

            db.query(query, [phoneNumber, monthNumber, yearInput], async (err, results) => {
                if (err) {
                    console.error('Database query error:', err);
                    return;
                }

                if (results.length === 0 || results[0].totalPemakaian === null) {
                    const message = `Data tagihan Anda untuk bulan ${monthInput} tidak ditemukan.`;
                    await sendWhatsAppMessage(phoneNumber, message);
                    return;
                }

                const { totalPemakaian, totalTagihan, statusTagihan } = results[0];
                const message = `Halo! Berikut adalah informasi tagihan Anda untuk bulan ${monthInput} ${yearInput}:\n\nTotal Pemakaian: ${totalPemakaian} m³\nTotal Tagihan: Rp ${totalTagihan.toLocaleString()}\n Status Tagihan:${statusTagihan}\n\nTerima kasih!`;
                await sendWhatsAppMessage(phoneNumber, message);
                return true;
            });
        }
    });
}

// Endpoint webhook untuk menerima data
app.post('/webhook', async (req, res) => {
    const payload = req.body;
    console.log('palyload:', payload);
    const phoneNumber = payload.body?.key?.remoteJid?.split('@')[0];
    let messageContent = payload.body?.message?.conversation || '';

    // Cek apakah pesan ada di extendedTextMessage
    if (!messageContent && payload.body?.message?.extendedTextMessage) {
        messageContent = payload.body.message.extendedTextMessage.text || '';
        console.log('extendedTextMessage:', messageContent);
    }

    // Cek apakah pesan ada di messageContextInfo
    if (!messageContent && payload.body?.message?.messageContextInfo) {
        const contextInfo = payload.body.message.messageContextInfo;
        messageContent = contextInfo.quotedMessage?.conversation || '';
        console.log('extendedTextMessage:', messageContent);
    
    }


    if (!phoneNumber) {
        return res.status(400).json({ status: 'error', message: 'Phone number not found in payload.' });
    }

    // Masukkan data ke antrian
    await addToQueue('commandQueue', { phoneNumber, messageContent });
    res.status(200).json({ status: 'success', message: 'Command added to queue.' });
});

// Jalankan server
app.listen(PORT, HOST, () => {
    console.log(`Webhook server running at http://${HOST}:${PORT}/webhook`);
});

module.exports = { handleCommand };
