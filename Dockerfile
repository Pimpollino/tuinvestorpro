# Usamos una imagen que ya tiene PHP 8 y Apache configurados
FROM php:8.2-apache

# Copiamos tus archivos a la carpeta donde Apache busca la web
COPY . /var/www/html/

# Damos permisos para que PHP pueda escribir en tu data.json
RUN chown -R www-data:www-data /var/www/html/