require('dotenv').config(); // 🔑 Chargement du fichier .env

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
app.use('/pdf', express.static(__dirname + '/pdf'));
const port = 3000;

// 🔗 Connexion MongoDB
mongoose.connect('mongodb://127.0.0.1:27017/livraison_db')
    .then(() => console.log('✅ Connecté à MongoDB'))
    .catch(err => console.error('❌ Erreur de connexion MongoDB :', err));

const Commande = mongoose.model('Commande', {
    adresseDepart: String,
    adresseArrivee: String,
    tarif: String,
    date: String,
    nomClient: String,
    refCommande: String
});

app.use(bodyParser.json());

function formatAdresse(location) {
    if (!location) return '';
    const champs = [
        location['street-address'],
        location['city'],
        location['admin-area'],
        location['country']
    ];
    return champs.filter(Boolean).join(', ');
}

app.post('/', (req, res) => {
    const body = req.body;
    console.log(JSON.stringify(body, null, 2));
    const intent = body.queryResult.intent.displayName;
    const context = body.queryResult.outputContexts.find(ctx => ctx.name.includes('adresse_donnee'));

    const rawDepart = context?.parameters?.adresse_depart;
    const rawArrivee = context?.parameters?.adresse_arrivee;
    const nomClient = context?.parameters?.nom_client || 'Client';

    const adresseDepart = formatAdresse(rawDepart);
    const adresseArrivee = formatAdresse(rawArrivee);
    const date = new Date().toLocaleDateString('fr-FR');
    const googleApiKey = 'AIzaSyCPkVYCamKtA9Avo7QRwR8mGYLpPc6NKyA'; // ✅ ta clé API Google

    if (intent === 'Calcul_Tarif') {
        console.log('📌 Intent : Calcul_Tarif');

        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(adresseDepart)}&destinations=${encodeURIComponent(adresseArrivee)}&key=${googleApiKey}&language=fr`;

        axios.get(url)
            .then(response => {
                const data = response.data;

                if (data.status !== 'OK' || data.rows[0].elements[0].status !== 'OK') {
                    return res.json({
                        fulfillmentText: `Désolé, je n’ai pas pu calculer la distance entre ${adresseDepart} et ${adresseArrivee}.`
                    });
                }

                const distanceInKm = data.rows[0].elements[0].distance.value / 1000;
                const tarif = Math.round(500 + distanceInKm * 250);

                res.json({
                    fulfillmentText: `Le tarif entre ${adresseDepart} et ${adresseArrivee} est de ${tarif} FCFA. Souhaitez-vous confirmer la livraison ?`
                });
            })
            .catch(error => {
                res.json({ fulfillmentText: `Erreur lors du calcul du tarif.` });
            });
    }

    else if (intent === 'Confirmation_Livraison') {
        console.log('📌 Intent : Confirmation_Livraison');

        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(adresseDepart)}&destinations=${encodeURIComponent(adresseArrivee)}&key=${googleApiKey}&language=fr`;

        axios.get(url)
            .then(response => {
                const data = response.data;

                if (data.status !== 'OK' || data.rows[0].elements[0].status !== 'OK') {
                    return res.json({
                        fulfillmentText: `Je n’ai pas pu confirmer la livraison à cause d’une erreur de distance.`
                    });
                }

                const distanceInKm = data.rows[0].elements[0].distance.value / 1000;
                const tarif = Math.round(500 + distanceInKm * 250);
                const refCommande = `CMD-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

                const doc = new PDFDocument();
                const fileName = `bon_livraison_${Date.now()}.pdf`;
                const filePath = `./pdf/${fileName}`;
                const writeStream = fs.createWriteStream(filePath);
                doc.pipe(writeStream);

                doc.fontSize(12).text('Colis à livrer');
                doc.text(`Référence : ${refCommande}`);
                doc.text(`Client : ${nomClient}`);
                doc.text(`Départ : ${adresseDepart}`);
                doc.text(`Arrivée : ${adresseArrivee}`);
                doc.text(`Tarif : ${tarif} FCFA`);
                doc.text(`Date : ${date}`);
                doc.end();

                writeStream.on('finish', () => {
                    const newCmd = new Commande({
                        adresseDepart,
                        adresseArrivee,
                        tarif: `${tarif} FCFA`,
                        date,
                        nomClient,
                        refCommande
                    });

                    newCmd.save()
                        .then(() => console.log('💾 Commande enregistrée'))
                        .catch(err => console.error('❌ MongoDB:', err));

                    const publicUrl = `${process.env.NGROK_URL}/pdf/${fileName}`;

                    const whatsappNumber = '+221789145867';
                    const callmebotApiKey = '3738930';
                    const message = encodeURIComponent(
                        `Bonjour ${nomClient}, votre commande a été confirmée ✅\nRéf : ${refCommande}\nVoici votre bon de livraison :\n${publicUrl}\n\nMerci pour votre confiance 🛵`
                    );

                    const callmebotUrl = `https://api.callmebot.com/whatsapp.php?phone=${whatsappNumber}&text=${message}&apikey=${callmebotApiKey}`;

                    axios.get(callmebotUrl)
                        .then(() => console.log('📲 Lien WhatsApp envoyé'))
                        .catch(err => console.error('❌ WhatsApp :', err.message));

                    res.json({
                        fulfillmentText: `Livraison confirmée ! Bon envoyé à ${nomClient} sur WhatsApp.`
                    });
                });

                writeStream.on('error', err => {
                    console.error('❌ PDF :', err);
                    res.json({ fulfillmentText: `Erreur PDF.` });
                });
            })
            .catch(error => {
                console.error('❌ API Google :', error);
                res.json({ fulfillmentText: `Erreur lors de la confirmation.` });
            });
    }

    else {
        res.json({ fulfillmentText: `Intent non géré : ${intent}` });
    }
});

app.get('/commandes', async (req, res) => {
    try {
        const commandes = await Commande.find();
        res.json(commandes);
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.listen(port, () => {
    console.log(`🚀 Webhook opérationnel sur http://localhost:${port}`);
});
