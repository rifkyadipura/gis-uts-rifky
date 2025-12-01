package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// FeatureDoc represents Mongo document (used internally)
type FeatureDoc struct {
	ID          primitive.ObjectID `bson:"_id,omitempty" json:"-"`
	Name        string             `bson:"name" json:"name"`
	Description string             `bson:"description,omitempty" json:"description,omitempty"`
	Geometry    bson.M             `bson:"geometry" json:"geometry"` // GeoJSON object
	Properties  bson.M             `bson:"properties,omitempty" json:"properties,omitempty"`
	CreatedAt   time.Time          `bson:"created_at" json:"created_at"`
	UpdatedAt   time.Time          `bson:"updated_at" json:"updated_at"`
}

// GeoJSONFeature for response
type GeoJSONFeature struct {
	Type       string      `json:"type"`
	Geometry   interface{} `json:"geometry"`
	Properties interface{} `json:"properties"`
}

// GeoJSONFeatureCollection for response
type GeoJSONFeatureCollection struct {
	Type     string           `json:"type"`
	Features []GeoJSONFeature `json:"features"`
}

var (
	client     *mongo.Client
	collection *mongo.Collection
	ctx        context.Context
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	ctx = context.Background()

	mongoURI := getenv("MONGO_URI", "mongodb://localhost:27017")
	dbName := getenv("MONGO_DB", "gisdb")
	collName := getenv("MONGO_COLLECTION", "features")
	port := getenv("PORT", "3000")

	// connect to Mongo
	var err error
	clientOpts := options.Client().ApplyURI(mongoURI)
	client, err = mongo.Connect(ctx, clientOpts)
	if err != nil {
		log.Fatalf("mongo connect error: %v", err)
	}
	if err = client.Ping(ctx, nil); err != nil {
		log.Fatalf("mongo ping error: %v", err)
	}
	collection = client.Database(dbName).Collection(collName)
	log.Println("Connected to Mongo:", mongoURI, "DB:", dbName, "Collection:", collName)

	// create 2dsphere index on geometry
	indexModel := mongo.IndexModel{
		Keys: bson.D{{Key: "geometry", Value: "2dsphere"}},
	}
	_, err = collection.Indexes().CreateOne(ctx, indexModel)
	if err != nil {
		log.Printf("index create warning: %v", err)
	} else {
		log.Println("Created/ensured 2dsphere index on geometry")
	}

	// router setup
	r := mux.NewRouter()
	r.Use(corsMiddleware)

	r.HandleFunc("/features", listFeaturesHandler).Methods("GET", "OPTIONS")
	r.HandleFunc("/features", createFeatureHandler).Methods("POST", "OPTIONS")
	r.HandleFunc("/features/{id}", updateFeatureHandler).Methods("PUT", "OPTIONS")
	r.HandleFunc("/features/{id}", deleteFeatureHandler).Methods("DELETE", "OPTIONS")
	r.HandleFunc("/healthz", healthHandler).Methods("GET")

	log.Printf("Server listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, r))
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// during dev you can allow all origins; restrict in production if needed
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

// parse ?bbox=minLon,minLat,maxLon,maxLat
func parseBBox(q string) (minLon, minLat, maxLon, maxLat float64, ok bool) {
	parts := strings.Split(q, ",")
	if len(parts) != 4 {
		return
	}
	var err error
	minLon, err = strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	if err != nil {
		return
	}
	minLat, err = strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if err != nil {
		return
	}
	maxLon, err = strconv.ParseFloat(strings.TrimSpace(parts[2]), 64)
	if err != nil {
		return
	}
	maxLat, err = strconv.ParseFloat(strings.TrimSpace(parts[3]), 64)
	if err != nil {
		return
	}
	ok = true
	return
}

// List features, supports bbox and near queries
func listFeaturesHandler(w http.ResponseWriter, r *http.Request) {
	q := bson.M{}
	query := r.URL.Query()
	if bbox := query.Get("bbox"); bbox != "" {
		minLon, minLat, maxLon, maxLat, ok := parseBBox(bbox)
		if ok {
			// Mongo $geoWithin with $box expects [[minLon,minLat],[maxLon,maxLat]]
			q["geometry"] = bson.M{
				"$geoWithin": bson.M{
					"$box": bson.A{
						bson.A{minLon, minLat},
						bson.A{maxLon, maxLat},
					},
				},
			}
		}
	} else if near := query.Get("near"); near != "" {
		// format near=lat,lon  and radius in meters ?radius=500
		parts := strings.Split(near, ",")
		if len(parts) == 2 {
			lat, err1 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
			lon, err2 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
			if err1 == nil && err2 == nil {
				maxDist := int64(5000)
				if r.URL.Query().Get("radius") != "" {
					if d, err := strconv.Atoi(r.URL.Query().Get("radius")); err == nil {
						maxDist = int64(d)
					}
				}
				q["geometry"] = bson.M{
					"$near": bson.M{
						"$geometry": bson.M{
							"type":        "Point",
							"coordinates": bson.A{lon, lat},
						},
						"$maxDistance": maxDist,
					},
				}
			}
		}
	}

	ctx2, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cur, err := collection.Find(ctx2, q)
	if err != nil {
		http.Error(w, "db find error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer cur.Close(ctx2)

	fc := GeoJSONFeatureCollection{Type: "FeatureCollection"}

	for cur.Next(ctx2) {
		var doc FeatureDoc
		if err := cur.Decode(&doc); err != nil {
			log.Println("decode warn:", err)
			continue
		}
		props := bson.M{
			"name":        doc.Name,
			"description": doc.Description,
			"id":          doc.ID.Hex(),
		}
		if doc.Properties != nil {
			for k, v := range doc.Properties {
				props[k] = v
			}
		}
		feature := GeoJSONFeature{
			Type:       "Feature",
			Geometry:   doc.Geometry,
			Properties: props,
		}
		fc.Features = append(fc.Features, feature)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(fc)
}

// Create feature (accept lat+lon or geojson geometry)
func createFeatureHandler(w http.ResponseWriter, r *http.Request) {
	var body map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}

	name, _ := body["name"].(string)
	desc, _ := body["description"].(string)
	now := time.Now().UTC()

	var geometry interface{}

	// accept { geojson: { type:..., coordinates:... } } OR lat+lon
	if g, ok := body["geojson"]; ok {
		geometry = g
	} else if latv, okLat := body["lat"]; okLat {
		if lonv, okLon := body["lon"]; okLon {
			lat, _ := toFloat(latv)
			lon, _ := toFloat(lonv)
			geometry = bson.M{
				"type":        "Point",
				"coordinates": bson.A{lon, lat},
			}
		}
	}

	if geometry == nil {
		http.Error(w, "geometry (geojson) or lat+lon required", http.StatusBadRequest)
		return
	}

	doc := bson.M{
		"name":        name,
		"description": desc,
		"geometry":    geometry,
		"created_at":  now,
		"updated_at":  now,
	}

	res, err := collection.InsertOne(ctx, doc)
	if err != nil {
		http.Error(w, "db insert error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	id := res.InsertedID.(primitive.ObjectID).Hex()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(bson.M{"id": id})
}

func updateFeatureHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	idHex := vars["id"]

	oid, err := primitive.ObjectIDFromHex(idHex)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	var body map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	update := bson.M{}

	if name, ok := body["name"].(string); ok {
		update["name"] = name
	}
	if desc, ok := body["description"].(string); ok {
		update["description"] = desc
	}

	if g, ok := body["geojson"]; ok {
		update["geometry"] = g
	} else if latv, okLat := body["lat"]; okLat {
		if lonv, okLon := body["lon"]; okLon {
			lat, _ := toFloat(latv)
			lon, _ := toFloat(lonv)
			update["geometry"] = bson.M{
				"type":        "Point",
				"coordinates": bson.A{lon, lat},
			}
		}
	}

	if len(update) == 0 {
		http.Error(w, "nothing to update", http.StatusBadRequest)
		return
	}

	update["updated_at"] = time.Now().UTC()

	_, err = collection.UpdateByID(ctx, oid, bson.M{"$set": update})
	if err != nil {
		http.Error(w, "db update error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(bson.M{"ok": true})
}

func deleteFeatureHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	idHex := vars["id"]

	oid, err := primitive.ObjectIDFromHex(idHex)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	_, err = collection.DeleteOne(ctx, bson.M{"_id": oid})
	if err != nil {
		http.Error(w, "db delete error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(bson.M{"ok": true})
}

func toFloat(v interface{}) (float64, error) {
	switch t := v.(type) {
	case float64:
		return t, nil
	case float32:
		return float64(t), nil
	case int:
		return float64(t), nil
	case int32:
		return float64(t), nil
	case int64:
		return float64(t), nil
	case string:
		return strconv.ParseFloat(t, 64)
	default:
		return 0, fmt.Errorf("unsupported type")
	}
}
